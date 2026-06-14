import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile } from './types.js';
import { single } from './types.js';

/**
 * C# dependency extractor — the HARDEST language, and the design's poster child for
 * SymbolTable resolution.
 *
 * WHY A SYMBOL TABLE (and why it is harder than every imports-only language): C# has
 * NO file-level import that names a file. A `using Foo.Bar;` names a NAMESPACE, and a
 * namespace is a symbol that spans arbitrarily many files in arbitrarily many
 * directories (one file may declare several namespaces; one namespace may be split
 * across the tree). There is no compile-time file→file edge in the syntax. The
 * dependency EDGE therefore comes from a SYMBOL USE — a type reference, a `new`, a base
 * type, a qualified name — resolved to a fully-qualified name (FQN) and looked up in the
 * shared SymbolTable.
 *
 * THE MODEL (mirrors kotlin.ts: declarations build FQN keys, uses emit `{kind:'symbol'}`
 * hints, NO resolve-path branch):
 *
 *  - declarations(file): each TYPE's FQN. The enclosing namespace is read from the
 *    ancestor chain — a `namespace_declaration` (block `namespace Foo { }`) or a
 *    `file_scoped_namespace_declaration` (`namespace Foo.Bar;`), with nested namespaces
 *    concatenated. For each class/interface/struct/record/enum declaration, emit
 *    `<namespace>.<TypeName>` (bare `<TypeName>` at file scope). These populate the
 *    shared SymbolTable as FQN→file.
 *
 *  - uses(file): build the file's USING SCOPE first — the set of namespace prefixes from
 *    each PLAIN `using Foo.Bar;` (D6: a `using_directive` with no `static`/`global` token
 *    child and no `name` field), plus an ALIAS map from `using Alias = Foo.Bar;` (D6: the
 *    `name` field carries the alias; the `qualified_name` sibling is the aliased FQN).
 *    `using static X;` (a `static` token child) is SKIPPED — it imports a type's static
 *    MEMBERS, not a namespace. `global using` declared in ANOTHER file is never honored
 *    (this extractor only sees THIS file). Then qualify each symbol reference:
 *      • an OUTERMOST `qualified_name` (a `qualified_name` whose parent is not itself a
 *        `qualified_name`) — e.g. in `new Foo.Bar.Baz()`, a base list, a field type, a
 *        static-call receiver — is ALREADY (likely) fully or partially qualified; its
 *        `.text` is a candidate FQN.
 *      • a BARE type identifier in a `base_list` entry or an `object_creation_expression`
 *        `type` field — for EACH using-scope prefix `P`, candidate FQN is `P.<Name>`;
 *        the alias map is tried too.
 *    Each candidate is emitted as `{kind:'symbol', symbolKey: candidateFQN}`. The
 *    resolver's `resolveUnique` returns undefined unless EXACTLY ONE definition matches —
 *    so emitting several candidates for a bare name is SAFE (only the real one resolves;
 *    the rest are non-events). This is the unambiguous-only discipline.
 *
 * SILENCE-ON-DOUBT (D8 — no waiver; a false positive blocks CI with no escape). All of
 * the following stay silent here, by construction:
 *   - DI-container registration / reflection (`Type.GetType`, `Activator.CreateInstance`)
 *     / extension methods / source generators — they surface no resolvable qualified type
 *     and no bare type in a base/`new` position, so no candidate FQN is emitted.
 *   - `using static X;` — skipped (no namespace prefix recorded).
 *   - `global using` declared in another file — invisible; a bare name it would have
 *     qualified simply yields no candidate, so SILENCE.
 *   - external-assembly / BCL types (System.*, Microsoft.*) — emit candidate FQNs, but
 *     they resolve to no in-graph file → resolveUnique undefined (or owner-of undefined) →
 *     never flagged.
 *   - any bare name that does not UNIQUELY resolve (zero or 2+ matches) → undefined.
 *
 * NO resolve-path branch: symbol hints route through the table; `makeResolvePathToFile`
 * returns undefined for csharp.
 *
 * v1 SCOPE = EXISTENCE. The edge is the TYPE DEPENDENCY (the symbol use). Method-call
 * relation-TYPE classification (calls vs uses vs extends) is deferred — this extractor
 * only establishes that a dependency on another node's type exists.
 *
 * D6 PROBE (verified against the shipped tree-sitter-c_sharp wasm by parsing samples):
 *   - using_directive: PLAIN `using Foo.Bar;` → `using` token + `qualified_name` child
 *     (or a single `identifier` child for a one-segment namespace), no `name` field.
 *     `using static X;` → an anonymous `static` token child present. `global using ...;`
 *     → an anonymous `global` token child. Alias `using Gw = Foo.Bar;` → `name` FIELD =
 *     identifier `Gw`, plus the aliased `qualified_name`/`identifier` sibling.
 *   - file_scoped_namespace_declaration: `name` field = qualified_name|identifier whose
 *     `.text` is the namespace FQN.
 *   - namespace_declaration (block): `name` field + `body=declaration_list`; nests.
 *   - class/interface/struct/record/enum _declaration: `name` field = identifier.
 *   - base_list: a CHILD (not a field) of the type decl; its namedChildren are the base
 *     types ({qualified_name, identifier, generic_name, primary_constructor_base_type}).
 *   - object_creation_expression: `type` field = identifier (bare) | qualified_name | …
 */

const TYPE_DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'record_struct_declaration',
  'enum_declaration',
]);

/**
 * The file-scoped namespace FQN (`namespace Foo.Bar;`), or '' if the file has none.
 *
 * D6 GOTCHA: a `file_scoped_namespace_declaration` does NOT nest the type declarations
 * as its children — the types are SIBLINGS in the `compilation_unit`. (C# allows at most
 * one file-scoped namespace, and it cannot mix with block namespaces at top level.) So
 * the ancestor walk in `blockNamespace()` cannot see it; it must be read off the
 * compilation unit once and prefixed onto every type's namespace.
 */
function fileScopedNamespace(root: Node): string {
  let ns = '';
  walk(root, (node) => {
    if (node.type === 'file_scoped_namespace_declaration') {
      const nameField = node.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') ns = nameField.text;
      return false; // at most one; do not descend
    }
    return undefined;
  });
  return ns;
}

/** The dotted BLOCK-namespace prefix for a node, read from its ancestor chain. Nested
 *  `namespace A { namespace B { } }` concatenates outermost-first → "A.B". Empty when no
 *  block namespace ancestor (the type may still sit in a file-scoped namespace). */
function blockNamespace(node: Node): string {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (cur.type === 'namespace_declaration') {
      const nameField = cur.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') parts.unshift(nameField.text);
    }
    cur = cur.parent;
  }
  return parts.join('.');
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. The namespace for each type is the
 * file-scoped namespace (if any) joined with the block-namespace ancestor chain. For
 * each type declaration (top-level AND nested — nesting does not change the owning node,
 * and the extra names let `Outer.Inner`-style access resolve), emit
 * `<namespace>.<TypeName>`, or bare `<TypeName>` at true file scope. These keys feed the
 * shared SymbolTable.
 */
function declarations(file: ParsedFile): DeclaredSymbol[] {
  const out: DeclaredSymbol[] = [];
  const fileNs = fileScopedNamespace(file.tree.rootNode);

  walk(file.tree.rootNode, (node) => {
    if (!TYPE_DECLARATION_TYPES.has(node.type)) return undefined;
    const nameField = node.childForFieldName('name');
    if (nameField === null || nameField.text === '') return undefined;
    const blockNs = blockNamespace(node);
    const ns = [fileNs, blockNs].filter((p) => p !== '').join('.');
    const symbolKey = ns === '' ? nameField.text : `${ns}.${nameField.text}`;
    out.push({ symbolKey, line: node.startPosition.row + 1 });
    return undefined;
  });

  return out;
}

interface UsingScope {
  /** Namespace prefixes from plain `using Foo.Bar;` directives. */
  prefixes: string[];
  /** alias local-name → aliased FQN from `using Alias = Foo.Bar;`. */
  aliases: Map<string, string>;
}

const NAMESPACE_NODE_TYPES = new Set([
  'qualified_name',
  'identifier',
  'generic_name',
  'alias_qualified_name',
]);

/** The imported namespace/type dotted text of a `using_directive`. When `skipName` is the
 *  directive's `name`-field node (the alias identifier in `using Alias = Foo.Bar;`), it is
 *  skipped so the ALIASED target is returned, not the alias name. */
function directiveNamespaceText(directive: Node, skipName: Node | null = null): string | undefined {
  for (let i = 0; i < directive.namedChildCount; i++) {
    const c = directive.namedChild(i);
    if (c === null) continue;
    if (skipName !== null && c.id === skipName.id) continue;
    if (NAMESPACE_NODE_TYPES.has(c.type)) return c.text;
  }
  return undefined;
}

/** True when the directive has an anonymous token child of the given keyword type. */
function hasTokenChild(directive: Node, token: string): boolean {
  for (let i = 0; i < directive.childCount; i++) {
    const c = directive.child(i);
    if (c !== null && !c.isNamed && c.type === token) return true;
  }
  return false;
}

/** Build the file's using scope: plain-namespace prefixes + alias map. Skips
 *  `using static` and `global using` per D6/silence discipline. */
function buildUsingScope(file: ParsedFile): UsingScope {
  const prefixes: string[] = [];
  const aliases = new Map<string, string>();

  walk(file.tree.rootNode, (node) => {
    if (node.type !== 'using_directive') return undefined;

    // `using static X;` imports a type's static MEMBERS, not a namespace → SKIP.
    if (hasTokenChild(node, 'static')) return undefined;

    // `using Alias = Foo.Bar;` — the `name` field is the alias; record alias→FQN. Do
    // NOT treat the alias as a namespace prefix. (`global using Alias = ...` lands here
    // too and is treated as a same-file alias, which is correct.)
    const aliasName = node.childForFieldName('name');
    if (aliasName !== null) {
      const fqn = directiveNamespaceText(node, aliasName);
      if (fqn !== undefined && fqn !== '') aliases.set(aliasName.text, fqn);
      return undefined;
    }

    // Plain `using Foo.Bar;` (or `global using Foo.Bar;` — a namespace import we DO
    // honor for THIS file's scope). The namespace text is a prefix for bare names.
    const ns = directiveNamespaceText(node);
    if (ns !== undefined && ns !== '') prefixes.push(ns);
    return undefined;
  });

  return { prefixes, aliases };
}

/** The bare type name a `base_list` entry or `object_creation_expression` type field
 *  carries, IFF it is an unqualified single identifier (qualified ones are handled by
 *  the qualified_name pass). Returns undefined for qualified / generic / other forms. */
function bareTypeName(node: Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === 'identifier') return node.text;
  return undefined;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const seen = new Set<string>();
  const scope = buildUsingScope(file);
  const fileNs = fileScopedNamespace(file.tree.rootNode);

  const emit = (symbolKey: string | undefined, line: number): void => {
    if (symbolKey === undefined || symbolKey === '') return;
    const dedupKey = `${symbolKey} ${line}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(single({ kind: 'symbol', symbolKey }, 'import', line));
  };

  /** Emit every candidate FQN for a BARE type name: each using prefix + name, plus the
   *  alias map. resolveUnique keeps only the one that actually resolves. */
  const emitBare = (name: string, line: number): void => {
    const alias = scope.aliases.get(name);
    if (alias !== undefined) emit(alias, line);
    for (const prefix of scope.prefixes) emit(`${prefix}.${name}`, line);
  };

  walk(file.tree.rootNode, (node) => {
    // Do NOT descend into directive/declaration HEADERS — their dotted names are the
    // imported namespace or the declared namespace name, not a symbol USE. (A
    // `using_directive` namespace is handled as a using-scope prefix above; a
    // `namespace Foo.Bar` header names the namespace being declared, not a dependency.)
    if (node.type === 'using_directive' || node.type === 'file_scoped_namespace_declaration') {
      return false;
    }
    if (node.type === 'namespace_declaration') {
      // Skip only the namespace NAME header; still descend into the body for real uses.
      const nameField = node.childForFieldName('name');
      if (nameField !== null) return undefined; // continue into children (incl. body)
    }

    // (a) Qualified references: emit the OUTERMOST qualified_name only (skip a
    //     qualified_name nested directly inside another — that is just the qualifier
    //     part of a longer dotted name, never an independent reference). A multi-segment
    //     `qualified_name` written inside a namespace or under a `using` is NOT provably
    //     a complete FQN — C# name lookup tries the enclosing-namespace and using-prefix
    //     expansions before the top-level interpretation. So we emit the verbatim text
    //     AND each expansion as candidates; resolveUnique's exactly-one-or-silence rule
    //     keeps the real edge and silences when two expansions resolve to different files.
    //     Only at TRUE FILE SCOPE (no using AND no enclosing namespace) is the verbatim
    //     text the sole possible meaning, so it is emitted alone. (Separator isolation:
    //     these are dot-only candidates; nested-type keys use `+` and never collide.)
    if (node.type === 'qualified_name') {
      // Skip the namespace-name qualified_name that is the `name` field of a block
      // namespace declaration (it names the namespace, not a dependency).
      if (node.parent !== null && node.parent.type === 'namespace_declaration') {
        const nm = node.parent.childForFieldName('name');
        if (nm !== null && nm.id === node.id) return undefined;
      }
      if (node.parent !== null && node.parent.type === 'qualified_name') return undefined;
      const line = node.startPosition.row + 1;
      const verbatim = node.text;
      // Enclosing namespace = file-scoped namespace joined with the block-namespace
      // ancestor chain of THIS reference.
      const enclosingNs = [fileNs, blockNamespace(node)].filter((p) => p !== '').join('.');
      if (enclosingNs !== '') emit(`${enclosingNs}.${verbatim}`, line);
      for (const prefix of scope.prefixes) emit(`${prefix}.${verbatim}`, line);
      emit(verbatim, line);
      return undefined;
    }

    // (b) Bare type identifiers in base_list entries → P.<Name> for each using prefix.
    if (node.type === 'base_list') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        const bare = bareTypeName(c);
        if (bare !== undefined) emitBare(bare, (c ?? node).startPosition.row + 1);
      }
      return undefined;
    }

    // (c) Bare type in `new Bare()` → P.<Name> for each using prefix.
    if (node.type === 'object_creation_expression') {
      const bare = bareTypeName(node.childForFieldName('type'));
      if (bare !== undefined) emitBare(bare, node.startPosition.row + 1);
      return undefined;
    }

    return undefined;
  });

  return out;
}

export const csharpExtractor: DependencyExtractor = {
  languages: new Set(['csharp']),
  declarations,
  uses,
};
