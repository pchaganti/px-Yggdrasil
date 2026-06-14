import type { Node } from 'web-tree-sitter';
import { walk } from '../../ast/walk.js';
import type { DependencyExtractor, DetectedDep, DeclaredSymbol, ParsedFile, TargetHint } from './types.js';

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
 *    `<namespace>.<TypeChain>`, where `<TypeChain>` is the enclosing-TYPE chain joined by
 *    the .NET reflection separator `+` and ending in the type's own simple name: a
 *    top-level type is `App.Type`, a nested `Inner` in `Outer` is `App.Outer+Inner`, a
 *    file-scope nested type is `Outer+Inner`. A nested type emits ONLY its `+` key, never
 *    also the bare simple name — that removes the collision that would otherwise let a
 *    nested `Inner` silence a legitimate top-level `App.Inner`. These populate the shared
 *    SymbolTable as FQN→file. Separator isolation: nested keys use `+`, namespace boundaries
 *    use `.`, so a dot-only use candidate never accidentally matches a `+` key.
 *
 *  - uses(file): build the file's USING SCOPE first — the set of namespace prefixes from
 *    each PLAIN `using Foo.Bar;` (D6: a `using_directive` with no `static`/`global` token
 *    child and no `name` field), plus an ALIAS map from `using Alias = Foo.Bar;` (D6: the
 *    `name` field carries the alias; the `qualified_name` sibling is the aliased FQN).
 *    `using static X;` (a `static` token child) is SKIPPED — it imports a type's static
 *    MEMBERS, not a namespace. `global using` declared in ANOTHER file is never honored
 *    (this extractor only sees THIS file). Then, for each symbol reference, build ONE
 *    ORDERED candidate group in C# name-binding order (nearest scope first, verbatim/
 *    top-level LAST), and emit it as a single `DetectedDep`:
 *      [alias-expansion?]                              ← leftmost segment is a local alias
 *        ++ [enclosing-namespace chain innermost→outermost]
 *        ++ [using-prefix block, code-point sorted]    ← ONE binding level
 *        ++ [verbatim / bare top-level]                ← farthest, last
 *    The per-reference resolver (`pass.ts`) walks this group and takes the FIRST candidate
 *    that binds to a UNIQUE mapped definition — that IS the binding; it emits at most one
 *    edge and STOPS, never reaching a farther candidate. A nearer candidate that is
 *    present-but-ambiguous (≥2 defs) SILENCES the whole group rather than leaking to the
 *    verbatim top-level interpretation. The verbatim form therefore only binds when nothing
 *    nearer does — which closes the decisive C# false positive (a partially-qualified ref
 *    whose verbatim top-level reading coincides with another node's same-named type).
 *      • an OUTERMOST `qualified_name` (a `qualified_name` whose parent is not itself a
 *        `qualified_name`) — e.g. in `new Foo.Bar.Baz()`, a base list, a field type, a
 *        static-call receiver — is partially or fully qualified; its `.text` is the verbatim
 *        last candidate, with the enclosing-namespace and using-prefix expansions ahead of it.
 *      • a BARE type identifier in a `base_list` entry or an `object_creation_expression`
 *        `type` field — alias, then the enclosing-namespace chain, then each using prefix,
 *        with the bare name itself last.
 *    Nested-type recovery is centralized in the resolver: for any dotted candidate it also
 *    tries the guarded `+`-boundary split (split `s1..sk + '+' + s_{k+1}..sn` only when
 *    `s1..sk` is a declared TYPE), so a use of `Outer.Inner` resolves to the `Outer+Inner`
 *    declaration key. The extractor emits dot-only candidates; the split is the resolver's.
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

/** The enclosing-TYPE chain of `node`, read from its ancestor chain, outermost-first.
 *  A nested `class Inner` inside `class Outer` yields `["Outer"]`; deeper nesting yields
 *  `["Outer", "Mid"]`. Empty when the type is not nested in another type. Joined with the
 *  type's own simple name by `+` (the .NET reflection FQN separator) — distinct from the
 *  namespace `.` so a nested key lives in a disjoint string space from any dot-only use
 *  candidate (separator isolation). */
function enclosingTypeChain(node: Node): string[] {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECLARATION_TYPES.has(cur.type)) {
      const nameField = cur.childForFieldName('name');
      if (nameField !== null && nameField.text !== '') parts.unshift(nameField.text);
    }
    cur = cur.parent;
  }
  return parts;
}

/**
 * The FULLY-QUALIFIED symbol keys this file DEFINES. The namespace for each type is the
 * file-scoped namespace (if any) joined with the block-namespace ancestor chain. The TYPE
 * part is the enclosing-type chain joined by the reflection separator `+`, ending in the
 * type's own simple name: a top-level type is `<namespace>.<TypeName>`; a nested type is
 * `<namespace>.<Outer>+<Inner>` (deeper: `<Outer>+<Mid>+<Inner>`); at true file scope the
 * namespace prefix is omitted (`<TypeName>` or `<Outer>+<Inner>`). A nested type emits ONLY
 * its `+` key — never also the bare simple name — so it cannot collide with, and silence, a
 * legitimate top-level type of the same simple name in another node. These keys feed the
 * shared SymbolTable; a use's `Outer.Inner` reference resolves to them via the resolver's
 * guarded `+`-boundary split.
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
    const typeKey = [...enclosingTypeChain(node), nameField.text].join('+');
    const symbolKey = ns === '' ? typeKey : `${ns}.${typeKey}`;
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

/** The enclosing-namespace prefixes for a reference, INNERMOST first. For a reference in
 *  `namespace App.Services.Sub` (file-scoped `App` + block chain `Services.Sub`) the chain
 *  is `["App.Services.Sub", "App.Services", "App"]` — C# looks an unqualified/partial name
 *  up against each progressively-shorter enclosing namespace, innermost outward, before the
 *  imports. An empty result means the reference sits at true file scope. */
function enclosingNamespaceChain(fileNs: string, node: Node): string[] {
  const segments = [fileNs, blockNamespace(node)]
    .filter((p) => p !== '')
    .join('.')
    .split('.')
    .filter((s) => s !== '');
  const chain: string[] = [];
  for (let i = segments.length; i >= 1; i--) chain.push(segments.slice(0, i).join('.'));
  return chain;
}

function uses(file: ParsedFile): DetectedDep[] {
  const out: DetectedDep[] = [];
  const scope = buildUsingScope(file);
  const fileNs = fileScopedNamespace(file.tree.rootNode);
  // Using prefixes are an UNORDERED set at one binding level — sort by code point so the
  // candidate order within that level is deterministic and never load-bearing.
  const sortedPrefixes = [...scope.prefixes].sort();

  /** Emit ONE ordered candidate group for a reference. `orderedKeys` is already in
   *  name-binding order (nearest first, verbatim/top-level last); duplicates are dropped
   *  in place preserving first-seen order (the dedup intent of the same-key-twice tests).
   *  A reference with no candidate (e.g. an unqualifiable bare name) emits nothing. */
  const pushGroup = (orderedKeys: Array<string | undefined>, line: number): void => {
    const seen = new Set<string>();
    const candidates: TargetHint[] = [];
    for (const key of orderedKeys) {
      if (key === undefined || key === '') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ kind: 'symbol', symbolKey: key });
    }
    if (candidates.length === 0) return;
    out.push({ candidates, kind: 'import', line });
  };

  /** Ordered candidate keys for a reference whose written text is `ref` (a dotted partial
   *  name or a bare identifier). Order: alias (if leftmost is a local alias) → enclosing-
   *  namespace chain innermost→outermost → using-prefix block (sorted) → verbatim/bare last. */
  const orderedKeysFor = (ref: string, node: Node): Array<string | undefined> => {
    const keys: Array<string | undefined> = [];
    const lead = ref.split('.')[0];
    const alias = scope.aliases.get(lead);
    if (alias !== undefined) {
      // The alias rewrites the leftmost segment; the rest of the dotted tail follows it.
      const tail = ref.slice(lead.length); // includes the leading '.', or '' for a bare ref
      keys.push(`${alias}${tail}`);
    }
    for (const ns of enclosingNamespaceChain(fileNs, node)) keys.push(`${ns}.${ref}`);
    for (const prefix of sortedPrefixes) keys.push(`${prefix}.${ref}`);
    keys.push(ref); // verbatim / bare top-level — LAST, binds only when nothing nearer does
    return keys;
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

    // (a) Qualified references: process the OUTERMOST qualified_name only (skip a
    //     qualified_name nested directly inside another — that is just the qualifier part
    //     of a longer dotted name, never an independent reference). A multi-segment
    //     `qualified_name` written inside a namespace or under a `using` is NOT provably a
    //     complete FQN — C# name lookup tries the enclosing-namespace and using-prefix
    //     expansions BEFORE the top-level interpretation. So the ordered group puts those
    //     expansions ahead of the verbatim text, which is LAST; first-unique-match-wins
    //     stops at the nearest binding and never falls through to the verbatim form unless
    //     nothing nearer binds. (Separator isolation: these are dot-only candidates; nested-
    //     type keys use `+` and never collide — the resolver derives `+` keys by guarded split.)
    if (node.type === 'qualified_name') {
      // Skip the namespace-name qualified_name that is the `name` field of a block
      // namespace declaration (it names the namespace, not a dependency).
      if (node.parent !== null && node.parent.type === 'namespace_declaration') {
        const nm = node.parent.childForFieldName('name');
        if (nm !== null && nm.id === node.id) return undefined;
      }
      if (node.parent !== null && node.parent.type === 'qualified_name') return undefined;
      pushGroup(orderedKeysFor(node.text, node), node.startPosition.row + 1);
      return undefined;
    }

    // (b) Bare type identifiers in base_list entries → ordered group (alias → enclosing-ns
    //     chain → using prefixes → bare name last).
    if (node.type === 'base_list') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        const bare = bareTypeName(c);
        if (bare !== undefined) pushGroup(orderedKeysFor(bare, c ?? node), (c ?? node).startPosition.row + 1);
      }
      return undefined;
    }

    // (c) Bare type in `new Bare()` → ordered group (same order as a bare base type).
    if (node.type === 'object_creation_expression') {
      const typeField = node.childForFieldName('type');
      const bare = bareTypeName(typeField);
      if (bare !== undefined) pushGroup(orderedKeysFor(bare, typeField ?? node), node.startPosition.row + 1);
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
