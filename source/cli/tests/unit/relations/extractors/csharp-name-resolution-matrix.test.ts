import { describe, it, expect } from 'vitest';
import { csharpExtractor, csharpUses, collectGlobalUsings } from '../../../../src/relations/extractors/csharp.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';
import { runCase } from '../reference-case-runner.js';

/**
 * C# NAME-RESOLUTION IDENTIFICATION MATRIX — characterization, one `it()` per
 * identification case (every syntactic form by which a C# type reference is detected
 * AND resolved). Each test asserts the SPEC-CORRECT outcome (extraction + resolution /
 * silence). For resolution-bearing cases the FP-trap variant (a same-name type in
 * ANOTHER node that must NOT be chosen) sits beside the positive.
 *
 * PASS  → the resolver already does the spec-correct thing (live `it`).
 * GAP   → it does not (documented as `it('GAP: ...')` so CI stays green).
 *
 * The spec rules (C# language spec / MS Learn), asserted here:
 *  R1  unqualified leading name: walk enclosing ns innermost→outermost→global;
 *      member→type→alias→UNIQUE using-import; STOP at first hit. Nearer wins.
 *  R2  using-imported type binds ONLY when unique; 2+ same-name = CS0104 → SILENCE.
 *  R3  usings/aliases are per-file (or per block-namespace body), non-transitive.
 *  R4  `using N;` imports types of EXACTLY N, NOT its nested namespaces.
 *  R5  `global using` applies PROJECT-WIDE; must aggregate before resolving simple names.
 *  R6  using-alias RHS is fully-qualified vs the bare enclosing ns; no alias chaining.
 *  R7  C#12 alias to closed generic/tuple/array → embedded named types are real deps.
 *  R8  co-definition (member I + alias I) → ambiguous → SILENCE.
 *  R9  CS0104 multi-import same-name → SILENCE (type_name AND expression contexts).
 *  R10 nearer-scope hiding: an imported name is hidden by a same-named member; the short
 *      name binds LOCAL, never a same-named top-level type in another namespace.
 *  R11 implicit/SDK usings are invisible to a source-only tool → unresolvable simple
 *      name may legitimately be SDK-imported → SILENCE.
 *  R12 `global::X` searches the global namespace; strip `global::`, resolve from root.
 *  R13 `alias::Type` / extern alias: left of `::` is ONLY an alias, never a type.
 */

async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'csharp' };
}

const symbolKeys = (uses: ReturnType<typeof csharpExtractor.uses>): string[] =>
  uses.flatMap((u) => u.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : [])));

const groupContaining = (
  uses: ReturnType<typeof csharpExtractor.uses>,
  key: string,
): string[] | undefined =>
  uses
    .find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key))
    ?.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : []));

/** Build a resolver over a SymbolTable + a flat file→owner map. */
function resolverOver(st: SymbolTable, owners: Record<string, string>): ReturnType<typeof makeResolver> {
  return makeResolver({
    ownerIndex: { ownerOf: (f: string) => owners[f] } as never,
    symbolTable: st,
    resolvePathToFile: () => undefined,
  });
}

/** Walk a reference's ordered group exactly as pass.ts does: first `resolved` wins (stop);
 *  a nearer `ambiguous` silences the whole group; `absent` continues. Returns the bound
 *  owner node, or undefined (silence). `dep` is the reference whose group contains `key`. */
function walkResolve(
  uses: ReturnType<typeof csharpExtractor.uses>,
  key: string,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
): string | undefined {
  const dep = uses.find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key));
  if (dep === undefined) return undefined;
  for (const cand of dep.candidates) {
    const o = resolver.classify(cand, fromFile, 'csharp');
    if (o.kind === 'resolved') return o.ownerNode;
    if (o.kind === 'ambiguous') return undefined;
  }
  return undefined;
}

/** Resolve EVERY reference in the file (any group) and return the bound owner per group.
 *  Used by silence cases: every group must yield undefined. */
function resolveAll(
  uses: ReturnType<typeof csharpExtractor.uses>,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
): Array<string | undefined> {
  return uses.map((u) => {
    for (const cand of u.candidates) {
      const o = resolver.classify(cand, fromFile, 'csharp');
      if (o.kind === 'resolved') return o.ownerNode;
      if (o.kind === 'ambiguous') return undefined;
    }
    return undefined;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — using-import & alias forms', () => {
  it('PASS R1: `using N;` + simple base `Type` → N.Type (unique); FP-trap top-level Type not chosen', async () => {
    // Positive: N.Type is the imported type. FP-trap: a top-level `Type` in node x must NOT
    // win — the using-prefix expansion `N.Type` is NEARER than the verbatim `Type` (last).
    const consumer = await parse('src/c/Use.cs', 'using N;\nclass C : Type { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'N.Type');
    expect(group).toEqual(['N.Type', 'Type']); // using-prefix first, verbatim LAST
    const st = new SymbolTable();
    st.declare('csharp', 'N.Type', 'src/n/Type.cs'); // the imported type (node n)
    st.declare('csharp', 'Type', 'src/x/Type.cs'); // FP-trap top-level Type (node x)
    const r = resolverOver(st, { 'src/n/Type.cs': 'n', 'src/x/Type.cs': 'x' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'N.Type', r, consumer.path)).toBe('n');
  });

  it('PASS R-static: `using static N.C;` records NO namespace prefix (members, not a namespace)', async () => {
    // `using static N.C;` imports C's static MEMBERS, not the namespace N — so a bare base
    // `Baz` gets no `N.Baz` candidate. (The dependency on C itself is not surfaced by this
    // extractor; that is a documented recall limitation, asserted in the GAP block below.)
    const { uses } = await run('using static N.C;\nclass D : Baz { }\n');
    const keys = symbolKeys(uses);
    expect(keys).not.toContain('N.Baz');
    expect(keys.some((k) => k.startsWith('N.'))).toBe(false);
  });

  // Migrated to the reference catalogue (reference/relations/csharp/csharp-using-alias.md):
  // the embedded fixture + documented outcome are the single source, asserted end-to-end
  // through the real relation pass by runCase. (Was: PASS R6 `using Alias = N.Type;`.)
  it('csharp-using-alias', () => runCase('csharp-using-alias'));

  it('PASS R6: `using Alias = N;` then `Alias.Type` → N.Type', async () => {
    // The alias rewrites the leftmost segment; the dotted tail follows it → N.Sub.Type.
    const consumer = await parse('src/c/Use.cs', 'using Al = N.Sub;\nnamespace App;\nclass C : Al.Type { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'N.Sub.Type');
    expect(group?.[0]).toBe('N.Sub.Type'); // alias-expanded, nearest
    const st = new SymbolTable();
    st.declare('csharp', 'N.Sub.Type', 'src/n/Type.cs');
    const r = resolverOver(st, { 'src/n/Type.cs': 'n' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'N.Sub.Type', r, consumer.path)).toBe('n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — global usings (project-wide aggregation)', () => {
  it('PASS R5 (same-file): `global using N;` in THIS file → bare `Type` qualifies via N', async () => {
    const consumer = await parse('src/c/Use.cs', 'global using N;\nclass C : Type { }\n');
    expect(symbolKeys(csharpExtractor.uses(consumer))).toContain('N.Type');
    const st = new SymbolTable();
    st.declare('csharp', 'N.Type', 'src/n/Type.cs');
    const r = resolverOver(st, { 'src/n/Type.cs': 'n' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'N.Type', r, consumer.path)).toBe('n');
  });

  it('GAP R5: a `global using N;` declared in a SIBLING file IS honored for THIS file (project-wide aggregation)', async () => {
    // R5: a `global using N;` in file A must make a bare `Type` in file B qualify as N.Type.
    // The fix is a project-wide pre-pass (pass.ts): aggregate every C# file's `global using`
    // prefixes via `collectGlobalUsings`, then inject the set into each file's `uses()` as its
    // lowest using tier (`csharpUses(file, { projectGlobalUsings })`). Here we reproduce that
    // pre-pass over the sibling + consumer exactly as pass.ts does, and assert the consumer's
    // bare `Type` now qualifies as N.Type and resolves to node n. (Implicit/SDK global usings
    // stay invisible to a source-only tool → correctly silenced; only declared ones aggregate.)
    const sibling = await parse('src/g/Globals.cs', 'global using N;\n');
    const consumer = await parse('src/c/Use.cs', 'class C : Type { }\n');
    // pass.ts pre-pass: aggregate global usings across every C# file before per-file resolution.
    const projectGlobalUsings = [
      ...new Set([...collectGlobalUsings(sibling), ...collectGlobalUsings(consumer)]),
    ];
    expect(projectGlobalUsings).toEqual(['N']);
    const usesWithGlobals = csharpUses(consumer, { projectGlobalUsings });
    expect(groupContaining(usesWithGlobals, 'N.Type')).toEqual(['N.Type', 'Type']);
    const st = new SymbolTable();
    st.declare('csharp', 'N.Type', 'src/n/Type.cs');
    const r = resolverOver(st, { 'src/n/Type.cs': 'n' });
    expect(walkResolve(usesWithGlobals, 'N.Type', r, consumer.path)).toBe('n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — namespace declaration shapes & enclosing-chain resolution', () => {
  it('PASS: file-scoped `namespace X;` qualifies declarations and enclosing-chain lookups', async () => {
    const { declarations } = await run('namespace X;\nclass C { }\n');
    expect(declarations.map((d) => d.symbolKey)).toContain('X.C');
  });

  it('PASS: block `namespace X { }` qualifies declarations and concatenates nested blocks', async () => {
    const { declarations } = await run('namespace A.B { namespace C { class T { } } }\n');
    expect(declarations.map((d) => d.symbolKey)).toContain('A.B.C.T');
  });

  it('PASS: nested namespace A.B.C — enclosing-chain emits innermost→outermost candidates', async () => {
    // A partial ref `Models.Order` in `namespace App.Services.Sub` tries each progressively
    // shorter enclosing namespace, innermost outward, before the verbatim form.
    const consumer = await parse(
      'src/c/Use.cs',
      'namespace App.Services.Sub;\nclass C { void M() { var o = new Models.Order(); } }\n',
    );
    const group = groupContaining(csharpExtractor.uses(consumer), 'Models.Order');
    expect(group).toEqual([
      'App.Services.Sub.Models.Order',
      'App.Services.Models.Order',
      'App.Models.Order',
      'Models.Order',
    ]);
  });

  it('PASS R1: partially-qualified `B.Type` inside `namespace A` → A.B.Type (nearest-first); FP-trap top-level B.Type not chosen', async () => {
    // The decisive FP class. Positive: A.B.Type (node n) is the nearer enclosing-ns binding.
    // FP-trap: a top-level B.Type (node x) must NOT win — it is the verbatim LAST candidate.
    const consumer = await parse('src/c/Use.cs', 'namespace A;\nclass C : B.Type { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'A.B.Type');
    expect(group).toEqual(['A.B.Type', 'B.Type']); // enclosing-ns first, verbatim LAST
    const st = new SymbolTable();
    st.declare('csharp', 'A.B.Type', 'src/n/Type.cs'); // the real nearer dep
    st.declare('csharp', 'B.Type', 'src/x/Type.cs'); // FP-trap top-level
    const r = resolverOver(st, { 'src/n/Type.cs': 'n', 'src/x/Type.cs': 'x' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'A.B.Type', r, consumer.path)).toBe('n');
  });

  it('PASS: fully-qualified `A.B.C.Type` in a base list emits the FQN candidate', async () => {
    const { uses } = await run('class C : A.B.C.Type { }\n');
    expect(symbolKeys(uses)).toContain('A.B.C.Type');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — qualified-reference & nested-type keying', () => {
  it('PASS: nested type use `Outer.Inner` resolves to `Outer+Inner` via the guarded split', async () => {
    const decl = await parse('src/a/Nested.cs', 'namespace App;\nclass Outer { class Inner { } }\n');
    const consumer = await parse(
      'src/c/Use.cs',
      'namespace Other;\nclass C { void M() { var x = new App.Outer.Inner(); } }\n',
    );
    const st = new SymbolTable();
    for (const d of csharpExtractor.declarations(decl)) st.declare('csharp', d.symbolKey, decl.path);
    const r = resolverOver(st, { 'src/a/Nested.cs': 'a' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'App.Outer.Inner', r, consumer.path)).toBe('a');
  });

  // R12 (`global::` resolution) is its own identification case — see the dedicated
  // `global:: prefix stripping` block at the end (it is a documented GAP).
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-reference SYNTACTIC positions (detection)', () => {
  it('PASS: base/interface list `class C : Base, IFoo {}` — bare bases detected', async () => {
    const { uses } = await run('using N;\nclass C : Base, IFoo { }\n');
    const keys = symbolKeys(uses);
    expect(keys).toContain('N.Base');
    expect(keys).toContain('N.IFoo');
  });

  it('PASS: `new Bare()` — object creation detected', async () => {
    const { uses } = await run('using N;\nclass C { void M() { var x = new Bare(); } }\n');
    expect(symbolKeys(uses)).toContain('N.Bare');
  });

  it('PASS: qualified field type `Foo.Bar.Dep _d;` — detected via the qualified_name pass', async () => {
    // A qualified_name anywhere (not only base/new) is walked; a field type qualifies.
    const { uses } = await run('namespace App;\nclass C { Foo.Bar.Dep _d; }\n');
    expect(symbolKeys(uses)).toContain('Foo.Bar.Dep');
  });

  it('GAP: bare field/param/return type `Foo _f;` is NOT detected — RECALL gap', async () => {
    // A bare (unqualified, non-generic) type in a field/param/return/local position is
    // `field_declaration > variable_declaration > identifier` — the extractor only inspects
    // bare identifiers in `base_list` and `object_creation_expression`. So a real dependency
    // expressed only as a member type (never constructed, never a base) is MISSED. RECALL.
    const { uses } = await run('using N;\nclass C { Foo _f; }\n');
    expect(symbolKeys(uses)).toContain('N.Foo');
  });

  it('GAP: generic `List<Foo>` — embedded `Foo` is NOT extracted — RECALL gap', async () => {
    // `generic_name` (List) + `type_argument_list` (Foo) is never descended for the type
    // argument. A dependency carried only as a generic type argument is MISSED. RECALL.
    const { uses } = await run('using N;\nclass C { List<Foo> _x; }\n');
    expect(symbolKeys(uses)).toContain('N.Foo');
  });

  it('GAP: attribute `[Foo]` / `[FooAttribute]` is NOT detected — RECALL gap', async () => {
    // `attribute_list > attribute > identifier` is never walked. Attribute type dependencies
    // (and the `Foo`→`FooAttribute` naming convention) are entirely MISSED. RECALL.
    const { uses } = await run('using N;\n[Foo]\nclass C { }\n');
    expect(symbolKeys(uses)).toContain('N.Foo');
  });

  it('GAP: generic constraint `where T : Constraint` is NOT detected — RECALL gap', async () => {
    // `type_parameter_constraint` carries the constraint type; never walked. RECALL.
    const { uses } = await run('using N;\nclass C<T> where T : Constraint { }\n');
    expect(symbolKeys(uses)).toContain('N.Constraint');
  });

  it('GAP: `typeof(X)` is NOT detected — RECALL gap', async () => {
    // `typeof_expression`'s type operand is never walked. RECALL.
    const { uses } = await run('using N;\nclass C { void M() { var t = typeof(X); } }\n');
    expect(symbolKeys(uses)).toContain('N.X');
  });

  it('GAP: `is X` / `as X` / cast `(X)x` are NOT detected — RECALL gap', async () => {
    // is_pattern_expression / as_expression / cast_expression type operands are never walked.
    // RECALL (each is a real type reference).
    const { uses } = await run(
      'using N;\nclass C { void M(object o) { var a = o as X; var b = (Y)o; if (o is Z) {} } }\n',
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('N.X');
    expect(keys).toContain('N.Y');
    expect(keys).toContain('N.Z');
  });

  it('GAP: tuple `(Foo, Bar)` / array `Foo[]` / nullable `Foo?` element types — NOT detected — RECALL gap', async () => {
    // tuple_type/tuple_element, array_type, nullable_type wrap an `identifier` the walk
    // never reaches (only base/new bare identifiers are inspected). RECALL.
    const { uses } = await run(
      'using N;\nclass C { (Foo, Bar) _t; Baz[] _a; Qux? _n; }\n',
    );
    const keys = symbolKeys(uses);
    expect(keys).toContain('N.Foo');
    expect(keys).toContain('N.Bar');
    expect(keys).toContain('N.Baz');
    expect(keys).toContain('N.Qux');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — C#12 alias to closed generic / tuple / array', () => {
  it('GAP R7: alias to a closed generic `using L = List<MyApp.Models.Customer>;` — embedded named types NOT extracted — RECALL gap', async () => {
    // R7: the EMBEDDED named types (here MyApp.Models.Customer) are real dependencies, and
    // the alias identifier `L` must not be mis-bound as a short name. ACTUAL: the alias RHS
    // is parsed for its dotted text only when it is a plain qualified_name/identifier; a
    // closed-generic RHS yields no usable alias FQN and its embedded type args are never
    // walked → the dependency on MyApp.Models.Customer is MISSED. RECALL (no FP — the alias
    // name `L` resolves to nothing, so it does not mis-bind either).
    const { uses } = await run(
      'using L = System.Collections.Generic.List<MyApp.Models.Customer>;\nnamespace App;\nclass C { L _x; }\n',
    );
    expect(symbolKeys(uses)).toContain('MyApp.Models.Customer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — extern alias / alias-qualified (`::`)', () => {
  it('PASS R13: `alias::Type` (extern alias) does NOT bind to a same-tail type in another node — SILENCE', async () => {
    // R13: the left of `::` is an extern/using alias, never a type. The extractor keeps the
    // literal `Lib::A.B.Base` text, which never matches a dot-only declaration key, so a
    // coincidental top-level A.B.Base in node x is NOT mis-bound. (This is silence-by-luck:
    // the alias is not stripped, but the unstripped key cannot collide → no FP.)
    const consumer = await parse('src/c/Use.cs', 'extern alias Lib;\nclass C : Lib::A.B.Base { }\n');
    const st = new SymbolTable();
    st.declare('csharp', 'A.B.Base', 'src/x/Base.cs'); // a same-tail type that must NOT bind
    const r = resolverOver(st, { 'src/x/Base.cs': 'x' });
    expect(resolveAll(csharpExtractor.uses(consumer), r, consumer.path).every((o) => o === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — SILENCE cases (must NOT bind / must silence)', () => {
  it('PASS R10: nearer-scope hiding — a local enclosing-ns type hides the using-imported same name (binds LOCAL, not foreign)', async () => {
    // `using Ext;` imports `Repo`; the enclosing namespace App ALSO declares `App.Repo`. The
    // short name `Repo` must bind the nearer App.Repo (node local), never the foreign Ext.Repo
    // (node ext). The enclosing-ns candidate is ordered ahead of the using-prefix candidate.
    const consumer = await parse('src/c/Use.cs', 'using Ext;\nnamespace App;\nclass C : Repo { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'App.Repo');
    expect(group).toEqual(['App.Repo', 'Ext.Repo', 'Repo']); // enclosing-ns first, then using, verbatim last
    const st = new SymbolTable();
    st.declare('csharp', 'App.Repo', 'src/local/Repo.cs'); // the nearer local type
    st.declare('csharp', 'Ext.Repo', 'src/ext/Repo.cs'); // the foreign imported type
    const r = resolverOver(st, { 'src/local/Repo.cs': 'local', 'src/ext/Repo.cs': 'ext' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'App.Repo', r, consumer.path)).toBe('local');
  });

  it('PASS R11: an implicit/SDK simple name with no visible using and no in-graph match → SILENCE', async () => {
    // Bare base `RepositoryBase` with no using/namespace: its only candidate is the verbatim
    // top-level form. With nothing in the table mapping it to a node (it would be SDK/implicit
    // imported), it resolves to nothing → SILENCE. No FP since it is not an in-graph node.
    const consumer = await parse('src/c/Use.cs', 'class C : RepositoryBase { }\n');
    expect(symbolKeys(csharpExtractor.uses(consumer))).toEqual(['RepositoryBase']);
    const r = resolverOver(new SymbolTable(), {});
    expect(resolveAll(csharpExtractor.uses(consumer), r, consumer.path).every((o) => o === undefined)).toBe(true);
  });

  it('PASS R2/R9 (verbatim level): a multi-import same-name FQN with 2 defs → ambiguous → SILENCE', async () => {
    // Two files declare the same FQN `MyApp.Dup.Thing`; a use of it is present-but-ambiguous
    // (2 defs) → the group silences rather than flagging. (This is CS0104 at the verbatim
    // candidate; the using-prefix CS0104 variant — two DIFFERENT same-name imports — is the
    // GAP below.)
    const consumer = await parse('src/z/Use.cs', 'namespace MyApp.Z;\nclass Use { void M() { var t = new MyApp.Dup.Thing(); } }\n');
    const st = new SymbolTable();
    st.declare('csharp', 'MyApp.Dup.Thing', 'src/x/Thing.cs');
    st.declare('csharp', 'MyApp.Dup.Thing', 'src/y/Thing.cs');
    const r = resolverOver(st, { 'src/x/Thing.cs': 'x', 'src/y/Thing.cs': 'y' });
    expect(r.classify({ kind: 'symbol', symbolKey: 'MyApp.Dup.Thing' }, consumer.path, 'csharp')).toEqual({ kind: 'ambiguous' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'MyApp.Dup.Thing', r, consumer.path)).toBeUndefined();
  });

  it('PASS: `using A;` + `B.Type` where B is a SUB-namespace of A — does NOT bind A.B.Type when no such type exists', async () => {
    // R4: `using A;` imports types of EXACTLY A, not of A.B. When there is NO `A.B.Type`
    // declared, the candidate `A.B.Type` resolves to nothing — so the spurious candidate is
    // harmless here, and the real top-level `B.Type` binds (node b). This passes by accident
    // of the table being empty at `A.B.Type`; the ACTIVE-harm variant is the GAP below.
    const consumer = await parse('src/c/Use.cs', 'using A;\nnamespace App;\nclass C : B.Type { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'B.Type');
    expect(group).toEqual(['App.B.Type', 'A.B.Type', 'B.Type']);
    const st = new SymbolTable();
    st.declare('csharp', 'B.Type', 'src/b/Type.cs'); // the real top-level B.Type
    const r = resolverOver(st, { 'src/b/Type.cs': 'b' });
    expect(walkResolve(csharpExtractor.uses(consumer), 'B.Type', r, consumer.path)).toBe('b');
  });

  it('GAP R4: `using A;` + `B.Type` (B sub-ns of A) MIS-BINDS `A.B.Type` when such a type happens to exist — FP-risk', async () => {
    // R4: `using A;` does NOT import A's nested namespace B, so `B.Type` must NOT resolve to
    // `A.B.Type`. ACTUAL: orderedKeysFor prepends every using prefix to a multi-segment ref,
    // producing the candidate `A.B.Type`, ordered AHEAD of the verbatim `B.Type`. If node aB
    // declares `A.B.Type` AND node b declares a real top-level `B.Type`, the walk binds the
    // nearer `A.B.Type` (aB) and STOPS — the wrong node, and a relation the spec would not
    // require. FP-RISK (mis-binds a dependency that does not exist per C# name lookup).
    const consumer = await parse('src/c/Use.cs', 'using A;\nnamespace App;\nclass C : B.Type { }\n');
    const st = new SymbolTable();
    st.declare('csharp', 'A.B.Type', 'src/aB/Type.cs'); // the spurious sub-ns target
    st.declare('csharp', 'B.Type', 'src/b/Type.cs'); // the real top-level target
    const r = resolverOver(st, { 'src/aB/Type.cs': 'aB', 'src/b/Type.cs': 'b' });
    // Spec-correct: bind the real top-level B.Type (node b), never the using-relative A.B.Type.
    expect(walkResolve(csharpExtractor.uses(consumer), 'B.Type', r, consumer.path)).toBe('b');
  });

  it('GAP R2/R9 (using-import CS0104): two usings each defining `Foo` → must SILENCE; resolver binds the first instead — FP-risk', async () => {
    // R9: `using A; using B;` where BOTH A.Foo and B.Foo exist (in DIFFERENT nodes) is CS0104
    // — the simple name `Foo` is ambiguous and MUST silence. ACTUAL: the group is
    // [A.Foo, B.Foo, Foo] (using prefixes code-point sorted); the ordered walk binds the FIRST
    // that resolves (A.Foo → node a) and STOPS. It never sees that B.Foo ALSO resolves, so it
    // does NOT detect the ambiguity — it commits to one arbitrary edge. The resolver's
    // ambiguity detection is per-candidate (≥2 files for ONE key), never ACROSS sibling
    // using-prefix candidates. FP-RISK (binds an edge C# would reject as ambiguous; the chosen
    // node is arbitrary and may be the wrong one).
    const consumer = await parse('src/c/Use.cs', 'using A;\nusing B;\nclass C : Foo { }\n');
    const group = groupContaining(csharpExtractor.uses(consumer), 'A.Foo');
    expect(group).toEqual(['A.Foo', 'B.Foo', 'Foo']);
    const st = new SymbolTable();
    st.declare('csharp', 'A.Foo', 'src/a/Foo.cs'); // node a
    st.declare('csharp', 'B.Foo', 'src/b/Foo.cs'); // node b — equally valid import → CS0104
    const r = resolverOver(st, { 'src/a/Foo.cs': 'a', 'src/b/Foo.cs': 'b' });
    // Spec-correct: SILENCE (undefined). ACTUAL: binds 'a' (first-resolved-wins).
    expect(walkResolve(csharpExtractor.uses(consumer), 'A.Foo', r, consumer.path)).toBeUndefined();
  });

  it('GAP R8: co-definition (enclosing member `I` + using-alias `I`) → must SILENCE; not modeled — silence gap', async () => {
    // R8: when an enclosing scope declares a member named `I` AND a using-alias `I` is in
    // scope, the simple name `I` is ambiguous (CS0104-class co-definition) and MUST silence.
    // ACTUAL: the extractor models an alias as a hard nearest override (alias expansion FIRST),
    // with no notion of a competing same-named enclosing member; it would bind the alias
    // target unconditionally. There is no member/alias co-definition ambiguity check. Modeled
    // here as: `using I = N.Thing;` while `App.I` also exists — spec says ambiguous → silence,
    // resolver binds the alias target N.Thing instead.
    const consumer = await parse('src/c/Use.cs', 'using I = N.Thing;\nnamespace App;\nclass C : I { }\n');
    const st = new SymbolTable();
    st.declare('csharp', 'N.Thing', 'src/n/Thing.cs'); // the alias target
    st.declare('csharp', 'App.I', 'src/app/I.cs'); // a co-defined enclosing member named I
    const r = resolverOver(st, { 'src/n/Thing.cs': 'n', 'src/app/I.cs': 'app' });
    // Spec-correct: co-definition is ambiguous → SILENCE (undefined).
    expect(walkResolve(csharpExtractor.uses(consumer), 'N.Thing', r, consumer.path)).toBeUndefined();
  });

  it('PASS: DI-container registration / reflection-string / extension-method call emit NO flag', async () => {
    const { uses } = await run(
      [
        'using Microsoft.Extensions.DependencyInjection;',
        'class Startup {',
        '  void Configure(IServiceCollection services) { services.AddScoped<IFoo, Foo>(); }',
        '  void R() { var t = System.Type.GetType("MyApp.Pay.Gateway"); }',
        '  void E(object order) { order.Validate(); }',
        '}',
        '',
      ].join('\n'),
    );
    const st = new SymbolTable();
    st.declare('csharp', 'MyApp.Pay.Gateway', 'src/pay/Gateway.cs'); // exists but only as a STRING
    const r = resolverOver(st, { 'src/pay/Gateway.cs': 'pay' });
    expect(resolveAll(uses, r, 'src/c/Use.cs').every((o) => o === undefined)).toBe(true);
  });

  it('PASS R3 (declaration check): the unrelated `using A;` does not propagate to a sibling file', async () => {
    // Per-file scope: file B has no `using A;`, so a bare `Base` in file B yields ONLY the
    // verbatim candidate `Base`, never `A.Base` from file A's import. (Cross-file leakage
    // would be an FP; this confirms it does not happen.)
    const fileB = await parse('src/b/B.cs', 'class C : Base { }\n');
    expect(symbolKeys(csharpExtractor.uses(fileB))).toEqual(['Base']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — global:: prefix stripping', () => {
  it('GAP R12: `global::A.B.Base` keeps the literal `global::` in the key → never resolves — RECALL gap', async () => {
    // R12: strip `global::` and resolve A.B.Base from the global root. ACTUAL: the
    // alias_qualified_name text `global::A.B.Base` is taken verbatim (and even prefixed to
    // `App.global::A.B.Base`); neither candidate matches the dot-only declaration key
    // `A.B.Base`, so a real dependency on node g is MISSED. RECALL (no FP — the bogus key
    // cannot collide with anything). Closing it needs a `global::`-strip in the extractor.
    const consumer = await parse('src/c/Use.cs', 'namespace App;\nclass C : global::A.B.Base { }\n');
    // ACTUAL keys (documented): ['App.global::A.B.Base', 'global::A.B.Base'].
    const st = new SymbolTable();
    st.declare('csharp', 'A.B.Base', 'src/g/Base.cs');
    const r = resolverOver(st, { 'src/g/Base.cs': 'g' });
    // Spec-correct: binds 'g' after stripping global::.
    const bound = resolveAll(csharpExtractor.uses(consumer), r, consumer.path).find((o) => o !== undefined);
    expect(bound).toBe('g');
  });
});

// `run`-style helper bound late so the describe blocks above can read clean.
async function run(code: string): Promise<{
  declarations: ReturnType<typeof csharpExtractor.declarations>;
  uses: ReturnType<typeof csharpExtractor.uses>;
}> {
  const f = await parse('x.cs', code);
  return { declarations: csharpExtractor.declarations(f), uses: csharpExtractor.uses(f) };
}
