import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * Kotlin dependency extractor — the FIRST language that resolves through the shared
 * SymbolTable rather than a path mapping.
 *
 * WHY A SYMBOL TABLE (not path arithmetic): Kotlin decouples a file's `package`
 * declaration from its directory (unlike Java's enforced package = directory layout),
 * and `.kts` scripts may have no package at all. So a file's FULLY-QUALIFIED names
 * cannot be derived from its path — they must be read from the parsed `package_header`
 * plus each declaration's simple name. `declarations()` therefore emits the FQNs this
 * file DEFINES (`<package>.<Name>`), which the pass folds into ONE shared SymbolTable;
 * `uses()` emits SYMBOL hints (the imported FQN) that resolve through that table via
 * `resolveUnique`. There is NO `resolve-path.ts` branch for Kotlin — symbol hints never
 * touch `resolvePathToFile`.
 *
 * v1 scope = EXISTENCE, not relation type. The unit of an inter-component edge in
 * Kotlin is the IMPORT: an `import` statement names a fully-qualified symbol (or, for a
 * wildcard import, a package). Usage-site nodes — `:` supertype lists, `by` delegation,
 * qualified calls, type references, `::` callable references — would only REFINE the
 * relation type of an already-imported binding, and v1 does not enforce relation type.
 * This extractor performs NO usage-site refinement: it emits exactly one symbol hint
 * per import.
 *
 * D6 PROBE (empirically confirmed against the shipped tree-sitter-grammars wasm):
 *  - The import node is `import` (a NAMED node), NOT `import_header`. Its FQN is the
 *    child `qualified_identifier` whose `.text` is the dotted path.
 *  - A wildcard `import com.foo.*` parses with the `qualified_identifier` ALREADY equal
 *    to the package (`com.foo`); the `*` is a separate unnamed token. So the FQN text is
 *    the package as-is. v1 emits the package FQN as the symbol hint (documented below).
 *  - An aliased `import com.foo.Bar as B` keeps the `qualified_identifier` as the real
 *    FQN (`com.foo.Bar`); the alias is a trailing `identifier` child. The alias is
 *    IGNORED — the hint is the FQN.
 *  - `package_header` has a `qualified_identifier` child (NO `name` field); its `.text`
 *    is the package FQN, possibly absent (root package).
 *  - `class_declaration` (which ALSO covers `interface`!), `object_declaration`, and
 *    `function_declaration` carry a `name` field (an `identifier`). `property_declaration`
 *    and `type_alias` do NOT: a property's name sits under a `variable_declaration`
 *    child's `identifier`; a type alias's name is a direct `identifier` child.
 *
 * WILDCARD HANDLING (documented v1 decision): `import com.foo.*` emits the PACKAGE FQN
 * (`com.foo`) as the symbol hint. A file's `declarations()` emits per-type FQNs
 * (`com.foo.Bar`), never the bare package, so a wildcard hint resolves through the
 * SymbolTable ONLY if some file happens to `declare` the package string itself — which
 * never happens in v1. In practice a wildcard import therefore resolves to undefined
 * (silence), i.e. v1 treats star imports as non-edges. This is the safe direction
 * (under-detect, never over-flag) and is consistent with the resolution-miss = non-event
 * precision rule. Per-member wildcard resolution is DEFERRED.
 *
 * stdlib / external imports (`kotlin.*`, `kotlinx.*`, `java.*`, AndroidX, third-party)
 * still emit a symbol hint here — silence is the SymbolTable's job (an FQN no in-graph
 * file declares resolves to undefined and is never flagged).
 *
 * INLINE FULLY-QUALIFIED TYPE references (`val x: app.dto.Req`, `: app.base.Base()`
 * supertype, `List<app.dto.Item>`) ARE emitted — as symbol hints, exactly like imports. A
 * fully-qualified type written without an import appears as a `user_type` whose leading
 * children are the dotted `identifier` segments. This node type occurs ONLY in TYPE
 * positions: an EXPRESSION-position dotted reference (`app.logging.Logger()`) parses as a
 * `navigation_expression` chain, never a `user_type`, so reading `user_type` captures type
 * references exclusively and never the member-access ambiguity. Only a MULTI-segment
 * user_type (≥2 dotted identifiers) is emitted — a bare `String` is import/same-package
 * resolved and stays silent. Resolution is the SymbolTable's distinct-file rule, so a name
 * that could bind two ways silences; an import-qualified nested ref (`Outer.Inner`, whose
 * `Outer` carries an import that already covers the edge) matches no package-qualified key
 * and stays silent — detection is additive recall with zero false positives. A type's
 * generic ARGUMENTS are nested `user_type`s and are emitted independently; the leading
 * segment collection stops at the first non-identifier child (the `type_arguments`).
 */

/** The FQN `qualified_identifier` child of an `import` node, as dotted text. A
 *  single-segment import is a bare `identifier` instead. Returns its `.text`. */
function importFqn(decl: Node): string | undefined {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (child === null) continue;
    if (child.type === 'qualified_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/** The dotted FQN of a `user_type`: its LEADING `identifier` children joined by `.`,
 *  stopping at the first non-identifier child (a `type_arguments` generic list). Returns
 *  undefined for a single-segment type (`String`) — not a fully-qualified reference. */
function dottedUserType(node: Node): string | undefined {
  const segs: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c === null) continue;
    if (c.type === 'identifier') segs.push(c.text);
    else break; // type_arguments / nested structure → stop the dotted prefix
  }
  return segs.length >= 2 ? segs.join('.') : undefined;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();

  const emit = (symbolKey: string | undefined, node: Node, kind: 'import' | 'type-ref' = 'import'): void => {
    if (symbolKey === undefined || symbolKey === '') return;
    const line = node.startPosition.row + 1;
    const dedupKey = `${symbolKey} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'symbol', symbolKey }, kind, line));
  };

  walk(file.tree.rootNode, (node) => {
    // Inline FQN type reference: a multi-segment `user_type` (type position only — an
    // expression-position dotted reference is a navigation_expression, never a user_type).
    if (node.type === 'user_type') {
      emit(dottedUserType(node), node, 'type-ref');
      return undefined;
    }

    // Match the NAMED `import` node, never the bare `import` keyword token.
    if (node.type !== 'import' || !node.isNamed) return undefined;
    // The FQN is the qualified_identifier text. For a wildcard the text is already the
    // package (the `*` is a separate token); for an alias the trailing identifier (the
    // `as B` binding) is a separate child and is NOT returned by importFqn — so the FQN
    // is emitted unchanged in every case.
    emit(importFqn(node), node);
    return undefined;
  });

  return out;
}

/** The simple name an `import`/`package`-bearing declaration defines, or undefined.
 *  `class`/`interface`/`object`/`function` carry a `name` field; a `property` nests it
 *  under `variable_declaration`; a `type_alias` exposes a direct `identifier` child. */
function declarationName(node: Node): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField !== null) return nameField.text;

  if (node.type === 'property_declaration') {
    // `val x = ...` → variable_declaration → identifier. (A multi_variable_declaration
    // destructures; v1 indexes only the single-name form, the common top-level case.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'variable_declaration') {
        const id = firstIdentifier(c);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }

  if (node.type === 'type_alias') {
    // `typealias Money = Long` → first named identifier child is the alias name.
    return firstIdentifier(node);
  }

  return undefined;
}

/** The text of the first named `identifier` descendant child of `node` (shallow). */
function firstIdentifier(node: Node): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c !== null && c.type === 'identifier') return c.text;
  }
  return undefined;
}

const DECLARATION_TYPES = new Set([
  'class_declaration', // covers both `class` and `interface`
  'object_declaration',
  'function_declaration',
  'property_declaration',
  'type_alias',
]);

/** The classifier nodes a nested declaration can sit INSIDE — its enclosing-type chain.
 *  `class`/`interface` (`class_declaration`), `object` (`object_declaration`), and a
 *  `companion object` (`companion_object`, whose JVM/source name is `Companion`). A
 *  `function_declaration` is NEVER an enclosing TYPE (a local class inside a function is not
 *  importable from outside), so it is excluded from the chain. */
const ENCLOSING_TYPE_TYPES = new Set([
  'class_declaration',
  'object_declaration',
  'companion_object',
]);

/** The enclosing-TYPE chain of `node`, read from its ancestor chain, outermost-first. A
 *  nested `class Inner` inside `class Outer` yields `["Outer"]`; deeper nesting yields
 *  `["Outer", "Mid"]`; a member inside a `companion object` yields `["Outer", "Companion"]`.
 *  Empty when the declaration is top-level (not nested in another type). Joined with the
 *  declaration's own simple name by the reflection separator `+` (Kotlin's JVM binary name
 *  is `Outer$Inner`; the analyzer's canonical key is `Outer+Inner` — same boundary), which
 *  is DISJOINT from the package `.` so a nested key lives in a string space no dot-only use
 *  candidate can match (separator isolation). This is what stops a nested `Inner` from being
 *  keyed as the bare top-level `<package>.Inner` and silencing — or mis-binding — a real
 *  top-level type of the same simple name in another node. */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (ENCLOSING_TYPE_TYPES.has(cur.type)) {
      // A `companion object` has no `name` field — its canonical name is `Companion`.
      const name = cur.type === 'companion_object' ? 'Companion' : cur.childForFieldName('name')?.text;
      if (name !== undefined && name !== '') parts.unshift(name);
    }
    cur = cur.parent;
  }
  return parts;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. Reads the file's `package_header`
 * (the package FQN, possibly empty for a root-package / `.kts` file), then for each
 * declaration (top-level AND nested) emits `<package>.<TypeKey>`, or just `<TypeKey>` when
 * the package is empty.
 *
 * `<TypeKey>` is the enclosing-TYPE chain joined to the declaration's own simple name by the
 * reflection separator `+`: a top-level `Order` is `Order`; a nested `Inner` inside `Outer`
 * is `Outer+Inner`; a member of a `companion object` is `Outer+Companion+member`. A NESTED
 * declaration emits ONLY its `+` key — NEVER also the bare `<package>.<SimpleName>`. Keying
 * a nested type flat (the v1 bug) manufactured a phantom top-level FQN: a `class Outer { class
 * Inner }` produced `<package>.Inner`, which a consumer's `import <package>.Inner` (in Kotlin
 * that names a TOP-LEVEL type, never the nested `Outer.Inner`) would mis-bind to this file —
 * a false positive — or which would collide with a real top-level `<package>.Inner` in another
 * node and silence its legitimate edge. The `+` key lives in a string space disjoint from the
 * dot-only namespace, so it cannot collide; a use of `import <package>.Outer.Inner` resolves
 * to it through the resolver's guarded `+`-boundary split (`Outer` is a declared type → split
 * to `<package>.Outer+Inner`).
 *
 * These keys feed the shared SymbolTable; a use's import FQN resolves against them.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];

  let pkg = '';
  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'package_header') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c !== null && c.type === 'qualified_identifier') {
        pkg = c.text;
        return false; // first package_header wins; stop descending it
      }
    }
    return false;
  });

  walk(file.tree.rootNode, (node) => {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    const name = declarationName(node);
    if (name === undefined || name === '') return undefined;
    const typeKey = [...enclosingTypeChain(node), name].join('+');
    const symbolKey = pkg === '' ? typeKey : `${pkg}.${typeKey}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });

  return out;
}

export const kotlinExtractor: DependencyExtractor = {
  languages: new Set(['kotlin']),
  rev: 2,
  declarations,
  uses,
};
