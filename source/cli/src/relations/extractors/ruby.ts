import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';

/**
 * Ruby dependency extractor — the LAST language, and honestly the LOWEST-detectability
 * one. Ruby uses BOTH hint kinds:
 *
 *   - PATH hints (`require_relative '<literal>'`) — the ONLY file-precise static link in
 *     the language. Resolved by `ruby-resolve.ts` relative to the requiring file.
 *   - SYMBOL hints (constants) — `class C < Base`, `include/extend/prepend Mod`,
 *     `Foo::Bar`, a bare `constant` used as a value/receiver. Resolved through the shared
 *     SymbolTable like Kotlin/C#.
 *
 * WHY MOSTLY SILENT (the honest framing): Ruby has no syntactic file binding for a
 * constant — a name carries only a name, never a path. Class/module REOPENING (a `class
 * Foo` body that adds to an `Foo` defined elsewhere) is indistinguishable at the AST
 * level from a fresh definition, so a reopened constant has 2+ definitions in the
 * SymbolTable → `resolveUnique` returns undefined → SILENCE. Zeitwerk/Rails autoload
 * means a constant is used with NO `require` at all; `const_get`/`send` metaprogramming
 * uses dynamic strings (never a `constant` node). The net effect: `require_relative` is
 * precise; constant deps are mostly silenced. This trades recall for ZERO false
 * positives BY DESIGN (D8 — no waiver, a false red blocks CI with no escape).
 *
 * v1 SCOPE = EXISTENCE, not relation type. The edge is "depends on a constant/file owned
 * by another node". No `calls`/`uses`/`extends`/`implements` classification here.
 *
 * D6 PROBE (verified against the shipped tree-sitter-ruby wasm by parsing real Ruby):
 *   - `require_relative` is a `call` (NOT a node type): `method` field = `identifier`
 *     text `require_relative`, NO `receiver` field, `arguments` = `argument_list` whose
 *     first named child is a `string` (children: `string_content`, no `interpolation`).
 *   - `class`: `name` field = `constant`; `superclass` field = `superclass` node whose
 *     single named child is a `constant` or `scope_resolution`.
 *   - `module`: `name` field = `constant`; `body` = `body_statement` (nests modules/classes).
 *   - `scope_resolution`: `scope` field (a `constant` or nested `scope_resolution`) + `name`
 *     field (a `constant`). `.text` preserves `::` as written; a leading `::Top` is a
 *     `scope_resolution` whose `scope` field is null.
 *   - include/extend/prepend: a `call`, NO receiver, `method`=identifier, `arguments`=
 *     `argument_list` with `constant`/`scope_resolution` arguments.
 *   - `assignment`: `left`/`right` fields; a top-level constant has a `constant` on `left`.
 *   - qualified call: a `call` whose `receiver` field is a `constant`/`scope_resolution`.
 *   - `class << self` parses as `singleton_class` (`value` field = `self`) — no `constant`
 *     name, so it is naturally excluded.
 */

/** Canonicalize a constant-name node (`constant` or `scope_resolution`) to a stable
 *  symbolKey string. A `scope_resolution` keeps the `::` separators as written; a leading
 *  `::` (top-level absolute reference) is stripped so it matches a definition recorded
 *  without it. Returns undefined for anything that is not a constant-name node. */
function constantKey(node: Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === 'constant') {
    const t = node.text;
    return t === '' ? undefined : t;
  }
  if (node.type === 'scope_resolution') {
    // `.text` preserves the full `A::B::C` (and a leading `::`). Strip a single leading
    // `::` so an absolute reference resolves against the same key a definition records.
    const t = node.text.replace(/^::/, '');
    return t === '' ? undefined : t;
  }
  return undefined;
}

/** The first named child of a node (or null). */
function firstNamedChild(node: Node): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c !== null) return c;
  }
  return null;
}

/** True when this `call` node is a bare (no-receiver) call to one of the given method
 *  names. Used for `require_relative` and the include/extend/prepend mixins. */
function isBareCallTo(node: Node, methods: ReadonlySet<string>): boolean {
  if (node.type !== 'call') return false;
  if (node.childForFieldName('receiver') !== null) return false;
  const method = node.childForFieldName('method');
  return method !== null && method.type === 'identifier' && methods.has(method.text);
}

/** The literal string argument of a `require_relative`-style call, or undefined. The
 *  argument must be a `string` with a single `string_content` child and NO `interpolation`
 *  child (a dynamic / interpolated argument is NOT statically resolvable → skip). */
function literalStringArg(callNode: Node): string | undefined {
  const args = callNode.childForFieldName('arguments');
  if (args === null) return undefined;
  const first = firstNamedChild(args);
  if (first === null || first.type !== 'string') return undefined;
  let content: string | undefined;
  for (let i = 0; i < first.namedChildCount; i++) {
    const c = first.namedChild(i);
    if (c === null) continue;
    if (c.type === 'interpolation') return undefined; // dynamic → not resolvable
    if (c.type === 'string_content') content = c.text;
  }
  return content; // undefined for an empty string `''` (no string_content child)
}

const MIXIN_METHODS = new Set(['include', 'extend', 'prepend']);
const REQUIRE_RELATIVE = new Set(['require_relative']);

/**
 * The dependency hints this file emits. TWO kinds:
 *   - PATH: a `require_relative '<lit>'` → `{kind:'path', specifier:<lit>}`.
 *   - SYMBOL: a superclass constant, a mixin-argument constant, a `scope_resolution`, and
 *     a bare `constant` used as a value/receiver → `{kind:'symbol', symbolKey:<name>}`.
 *
 * Definition-position constants (a `class`/`module` `name` field) are EXCLUDED so a node
 * never depends on itself. The superclass and mixin constants are emitted under the same
 * symbol channel (v1 does not classify relation type). To avoid double-counting and stray
 * descent, the walk handles each construct then prunes its constant children.
 */
function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emitPath = (specifier: string | undefined, line: number): void => {
    if (specifier === undefined || specifier === '') return;
    const dedupKey = `path\0${specifier}\0${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push({ targetHint: { kind: 'path', specifier }, kind: 'import', line });
  };

  const emitSymbol = (symbolKey: string | undefined, line: number): void => {
    if (symbolKey === undefined || symbolKey === '') return;
    const dedupKey = `symbol\0${symbolKey}\0${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push({ targetHint: { kind: 'symbol', symbolKey }, kind: 'import', line });
  };

  walk(file.tree.rootNode, (node) => {
    // (a) require_relative '<lit>' → PATH hint. Skip a non-literal / interpolated arg.
    if (isBareCallTo(node, REQUIRE_RELATIVE)) {
      emitPath(literalStringArg(node), node.startPosition.row + 1);
      // The literal is a string, not a constant; nothing to prune for symbols. Continue.
      return undefined;
    }

    // (b) class C < Base → SYMBOL hint for the superclass constant. The `name` field is a
    //     self-definition (excluded); only the `superclass` constant is a dependency.
    if (node.type === 'class') {
      const sup = node.childForFieldName('superclass');
      if (sup !== null) {
        // The superclass node's single named child is the constant / scope_resolution.
        const expr = firstNamedChild(sup);
        emitSymbol(constantKey(expr), (expr ?? sup).startPosition.row + 1);
      }
      return undefined; // descend into the body; the `name` constant is handled below (skipped)
    }

    // (c) include / extend / prepend Mod[, Mod2] → SYMBOL hint per constant argument.
    if (isBareCallTo(node, MIXIN_METHODS)) {
      const args = node.childForFieldName('arguments');
      if (args !== null) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const arg = args.namedChild(i);
          const key = constantKey(arg);
          if (key !== undefined && arg !== null) emitSymbol(key, arg.startPosition.row + 1);
        }
      }
      // The mixin-argument constants are counted; prune so the generic constant pass below
      // does not re-emit them (it would dedupe anyway, but pruning keeps lines exact).
      return undefined;
    }

    // (d) A bare `constant` or a `scope_resolution` used as a value / receiver. EXCLUDE
    //     definition positions: the `name` field of a `class`/`module`, and the `scope`
    //     part of a longer `scope_resolution` (counted whole via the outermost node).
    if (node.type === 'constant' || node.type === 'scope_resolution') {
      const parent = node.parent;
      if (parent !== null) {
        // Skip the `name` field of a class/module declaration (self-definition).
        if (parent.type === 'class' || parent.type === 'module') {
          const nameField = parent.childForFieldName('name');
          if (nameField !== null && nameField.id === node.id) return false;
        }
        // Skip a constant/scope_resolution nested INSIDE another scope_resolution — it is
        // only the qualifier of a longer dotted name; the outermost node carries the key.
        if (parent.type === 'scope_resolution') return false;
        // The superclass constant is handled in (b); skip it here (prune its subtree).
        if (parent.type === 'superclass') return false;
      }
      emitSymbol(constantKey(node), node.startPosition.row + 1);
      // Prune: a scope_resolution's inner constants must not be visited as bare names.
      return false;
    }

    return undefined;
  });

  return out;
}

/**
 * The constant FQNs this file DEFINES — every `class` and `module` definition plus every
 * top-level constant assignment. The FQN is built from LEXICAL NESTING: a `class
 * OrderService` inside `module App; module Services` defines `App::Services::OrderService`.
 *
 * REOPENINGS ARE NOT DEDUPED (intentional and correct): every reopening of a class/module
 * emits another definition of the same FQN. The pass folds these into the shared
 * SymbolTable, which then has 2+ files for that FQN → `resolveUnique` returns undefined →
 * any use of it is SILENCED. This is exactly the anti-false-positive behavior Ruby needs
 * (monkey-patching / reopening must never produce a flag).
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];

  // Walk with an explicit namespace stack so nested class/module names get their FQN.
  const visit = (node: Node, nsStack: string[]): void => {
    if (node.type === 'class' || node.type === 'module') {
      const nameField = node.childForFieldName('name');
      const name = constantKey(nameField);
      if (name !== undefined) {
        const fqn = nsStack.length === 0 ? name : `${nsStack.join('::')}::${name}`;
        out.push({ symbolKey: fqn, line: node.startPosition.row + 1 });
        // Descend into the body under the EXTENDED namespace. The name itself may be a
        // scoped name (`class A::B`), in which case it already carries its own prefix; push
        // the whole FQN so deeper nesting concatenates correctly.
        const body = node.childForFieldName('body');
        if (body !== null) {
          const childNs = [...nsStack, name];
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c !== null) visit(c, childNs);
          }
        }
        return;
      }
    }

    // Top-level constant assignment: `MAX = 5`, `MyAlias = OriginalClass`. The `left` field
    // is a `constant`. (A scoped `Foo::BAR = ...` assignment to a constant is rare and not
    // a node-defining declaration — skip; only a bare top-level constant is indexed.)
    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      if (left !== null && left.type === 'constant') {
        const name = left.text;
        if (name !== '') {
          const fqn = nsStack.length === 0 ? name : `${nsStack.join('::')}::${name}`;
          out.push({ symbolKey: fqn, line: node.startPosition.row + 1 });
        }
      }
      // An assignment's right-hand side is a USE, not a definition — do not recurse for defs.
      return;
    }

    // Generic descent for everything else (the body_statement of a class/module is reached
    // via the explicit recursion above; here we cover the top-level program and any other
    // container that may hold a class/module/assignment).
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null) visit(c, nsStack);
    }
  };

  visit(file.tree.rootNode, []);
  return out;
}

export const rubyExtractor: DependencyExtractor = {
  languages: new Set(['ruby']),
  declarations,
  uses,
};
