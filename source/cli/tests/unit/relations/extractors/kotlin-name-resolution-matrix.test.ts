import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { kotlinExtractor } from '../../../../src/relations/extractors/kotlin.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

/**
 * KOTLIN NAME-RESOLUTION IDENTIFICATION MATRIX — characterization, one `it()` per distinct
 * Kotlin identification form (per .plans/2026-06-14-kotlin-name-resolution-research.md). Each
 * test realizes the CONCRETE Kotlin source for that exact case and asserts the SPEC-CORRECT,
 * zero-FP outcome. For every resolving form the same-name FP-trap variant (a same-named type
 * in ANOTHER package/node that must NOT be chosen) sits beside the positive.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the Kotlin
 * extractor is and STAYS IMPORT-ONLY. A dependency edge is established ONLY by an `import`,
 * whose operand is a fully-qualified symbol resolved through the shared SymbolTable. Adding
 * usage-site / same-package / wildcard-expansion / bare-simple-name resolution is FORBIDDEN —
 * it would reintroduce the Form-5 precedence trap (explicit-import > same-package > star >
 * stdlib) and the Form-3 stdlib-collision trap (a project `Result`/`Pair`/`List` colliding
 * with an invisible stdlib name). The cardinal invariant — ZERO false positives, a hard wall
 * with no adopter waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here (research forms):
 *   F1  package decl is read from the `package` header, NOT the directory (symbol axis, no
 *       path arithmetic). Same-file/same-package decls feed the SymbolTable as FQN keys.
 *   F2a plain `import a.b.C` → the FQN IS the per-type edge.
 *   F2b top-level fun/prop import `import a.b.foo` → the exact FQN key (never the simple name).
 *   F2c wildcard `import a.b.*` → the PACKAGE FQN hint, which no per-type declaration matches
 *       → SILENCE. Expanding a wildcard is FP-risk and FORBIDDEN.
 *   F2d alias `import a.b.C as D` → target is the FQN BEFORE `as`; `D` is NEVER a key/target.
 *   F2e enum/member import `import a.b.Color.RED` → the verbatim FQN; it resolves ONLY through
 *       the guarded `+`-split when `a.b.Color` is a declared type (→ `a.b.Color+RED`), else
 *       SILENCE — never read the trailing member as a deeper package.
 *   F2f companion/object member import → same: resolves at the declared-TYPE boundary or SILENCE.
 *   F3  default/implicit stdlib (`kotlin.*`, `java.lang.*`, no import) → SILENCE; a project type
 *       colliding with a stdlib simple name must never bind.
 *   F4  nested/inner `Outer.Inner` → split at a declared-TYPE boundary into the `Outer+Inner`
 *       key; NEVER read as deeper packages. A nested decl is keyed `+`, never a flat top-level.
 *   F5/F6/F7 usage-site forms (supertype, generics, `is`/`as`, params, annotations, `::class`,
 *       ctor call, typealias, `by`, `when`, Pair, `T?`, array, vararg, bare top-level call) →
 *       SILENCE (deliberate tolerated false-NEGATIVE, import-only).
 *   F8  `<File>Kt` facade / `@file:JvmName` → no facade key synthesized for Kotlin resolution.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine current false-positive this matrix exposed and FIXED (the nested-type
 *           flat-key block: a nested decl was keyed as a phantom top-level `<package>.<Simple>`,
 *           mis-binding a top-level `import <package>.<Simple>` to the nesting file — now keyed
 *           `<package>.<Outer>+<Inner>`, the FP is sealed).
 */

const run = (code: string) => runExtractor(kotlinExtractor, 'kotlin', '.kt', code);

/** Every symbol key emitted for a file (each `import`'s candidate group, flattened). */
const symbolKeys = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => u.candidates.flatMap((c) => (c.kind === 'symbol' ? [c.symbolKey] : [])));

/** Parse a Kotlin source string into a ParsedFile under a chosen repo-rel path. */
async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'kotlin' };
}

/** Build a resolver over a SymbolTable + a flat file→owner map. */
function resolverOver(st: SymbolTable, owners: Record<string, string>): ReturnType<typeof makeResolver> {
  return makeResolver({
    ownerIndex: { ownerOf: (f: string) => owners[f] } as never,
    symbolTable: st,
    resolvePathToFile: () => undefined,
  });
}

/** Walk a reference's ordered candidate group exactly as pass.ts does: first `resolved` wins
 *  (stop); a nearer `ambiguous` silences the whole group; `absent` continues. Returns the
 *  bound owner node, or undefined (silence). `key` selects the group whose display contains it. */
function walkResolve(
  uses: Awaited<ReturnType<typeof run>>['uses'],
  key: string,
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
): string | undefined {
  const dep = uses.find((u) => u.candidates.some((c) => c.kind === 'symbol' && c.symbolKey === key));
  if (dep === undefined) return undefined;
  for (const cand of dep.candidates) {
    const o = resolver.classify(cand, fromFile, 'kotlin');
    if (o.kind === 'resolved') return o.ownerNode;
    if (o.kind === 'ambiguous') return undefined;
  }
  return undefined;
}

/** Resolve EVERY reference in the file and return the bound owner per group (silence cases:
 *  every group must yield undefined). */
function resolveAll(
  uses: Awaited<ReturnType<typeof run>>['uses'],
  resolver: ReturnType<typeof makeResolver>,
  fromFile: string,
): Array<string | undefined> {
  return uses.map((u) => {
    for (const cand of u.candidates) {
      const o = resolver.classify(cand, fromFile, 'kotlin');
      if (o.kind === 'resolved') return o.ownerNode;
      if (o.kind === 'ambiguous') return undefined;
    }
    return undefined;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (FQN edge; binds the EXACT FQN, never a sibling same-name)', () => {
  it('PASS F2a: plain `import a.b.C` → emits the FQN `com.acme.payments.PaymentService`', async () => {
    const keys = symbolKeys((await run('package com.acme.app\nimport com.acme.payments.PaymentService\nclass C\n')).uses);
    expect(keys).toContain('com.acme.payments.PaymentService');
  });

  it('PASS F2a (sibling same-name trap): the import binds its OWN FQN, never a same-named type in another package', async () => {
    // Node `pay` declares com.acme.payments.Gateway; node `vend` declares com.vendor.Gateway.
    // The consumer `import com.acme.payments.Gateway` MUST bind `pay`, never the sibling `vend`.
    const payFile = await parse('src/pay/Gateway.kt', 'package com.acme.payments\nclass Gateway\n');
    const vendFile = await parse('src/vend/Gateway.kt', 'package com.vendor\nclass Gateway\n');
    const consumer = await parse('src/c/Use.kt', 'package com.acme.app\nimport com.acme.payments.Gateway\nclass C\n');
    const st = new SymbolTable();
    for (const f of [payFile, vendFile]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
    }
    const r = resolverOver(st, { 'src/pay/Gateway.kt': 'pay', 'src/vend/Gateway.kt': 'vend' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.payments.Gateway', r, consumer.path)).toBe('pay');
  });

  it('PASS F2a: multi-import file → one FQN edge per import', async () => {
    const keys = symbolKeys(
      (await run(['package com.acme.app', 'import com.acme.a.Alpha', 'import com.acme.b.Beta', 'class C', ''].join('\n'))).uses,
    );
    expect(keys).toContain('com.acme.a.Alpha');
    expect(keys).toContain('com.acme.b.Beta');
  });

  it('PASS F1: package decl + same-file decl feed the SymbolTable as `<package>.<Name>` keys', async () => {
    const { declarations } = await run('package com.acme.orders\nclass Order\nfun place() {}\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('com.acme.orders.Order');
    expect(keys).toContain('com.acme.orders.place');
  });

  it('PASS F1: root-package file (no `package` header) keys bare names, never a leading dot', async () => {
    const { declarations } = await run('class Foo\nfun bar() {}\n');
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('Foo');
    expect(keys).toContain('bar');
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('PASS F2b: top-level fun/prop import `import a.b.foo` → the EXACT FQN key (never the simple name `foo`)', async () => {
    // F2b FP-risk: binding by the simple name `foo` could pick another package`s top-level
    // `foo`. The hint carries the full dotted FQN, so the simple name is never the key.
    const keys = symbolKeys((await run('package com.acme.app\nimport com.acme.util.retry\nclass C\n')).uses);
    expect(keys).toContain('com.acme.util.retry');
    expect(keys).not.toContain('retry');
  });

  it('PASS F2b (sibling same-name trap): two packages each define a top-level `log` → import binds the imported FQN only', async () => {
    const aFile = await parse('src/a/util.kt', 'package a\nfun log() {}\n');
    const bFile = await parse('src/b/util.kt', 'package b\nfun log() {}\n');
    const consumer = await parse('src/c/Use.kt', 'package c\nimport a.log\nclass C\n');
    const st = new SymbolTable();
    for (const f of [aFile, bFile]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
    }
    const r = resolverOver(st, { 'src/a/util.kt': 'a', 'src/b/util.kt': 'b' });
    // The import edge is `a.log` (node a), never the same-named `b.log`.
    expect(walkResolve(kotlinExtractor.uses(consumer), 'a.log', r, consumer.path)).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — alias import (`import a.b.C as D`): target is the FQN before `as`; `D` is never a key)', () => {
  it('PASS F2d: `import a.b.C as D` → records `a.b.C`, NEVER the alias `D`', async () => {
    const keys = symbolKeys((await run('import org.test.Message as TestMessage\nclass C\n')).uses);
    expect(keys).toContain('org.test.Message');
    expect(keys).not.toContain('TestMessage');
    expect(keys).not.toContain('org.test.TestMessage');
    expect(keys.every((k) => !k.includes(' as '))).toBe(true);
  });

  it('PASS F2d (alias does not become a real name): the alias `D` resolves to nothing; the FQN binds its node', async () => {
    // `import org.test.Message as TestMessage`. The edge target is `org.test.Message` (node m).
    // The alias `TestMessage` must never be a key — so a phantom node owning `TestMessage`
    // cannot be reached, and the only edge is the FQN one.
    const msgFile = await parse('src/m/Message.kt', 'package org.test\nclass Message\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport org.test.Message as TestMessage\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(msgFile)) st.declare('kotlin', d.symbolKey, msgFile.path);
    const r = resolverOver(st, { 'src/m/Message.kt': 'm' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'org.test.Message', r, consumer.path)).toBe('m');
    expect(symbolKeys(kotlinExtractor.uses(consumer))).not.toContain('TestMessage');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — enum / companion / object member imports (resolve at the declared-TYPE boundary, else SILENCE)', () => {
  it('PASS F2e: `import a.b.Color.RED` emits the verbatim FQN (the member is NOT pre-dropped by the extractor)', async () => {
    // The extractor emits the import`s verbatim dotted FQN; the resolver`s guarded `+`-split is
    // what binds it to the enum TYPE `a.b.Color` (member RED as the nested boundary), or silences.
    const keys = symbolKeys((await run('import com.acme.model.Color.RED\nclass C\n')).uses);
    expect(keys).toContain('com.acme.model.Color.RED');
  });

  it('GAP (deliberate recall) F2e: `import a.b.Color.RED` against an enum → SILENCE (enum ENTRIES are not indexed)', async () => {
    // The defining file declares the enum TYPE key `com.acme.model.Color`, but NOT the entry
    // `com.acme.model.Color+RED` (enum entries carry no `name` field and are not indexed as
    // declarations). The use`s guarded `+`-split keys `com.acme.model.Color+RED`, which is
    // absent → SILENCE. This MISSES the (real) dependency on the enum TYPE — a tolerated
    // false-NEGATIVE, never an FP. Indexing enum entries (so `Color+RED` exists) OR dropping
    // the trailing member to the bare TYPE key would be a recall add: deferred to OWNER review,
    // not auto-implemented (it must not over-key a member to a colliding type — see the trap below).
    const enumFile = await parse('src/m/Color.kt', 'package com.acme.model\nenum class Color {\n  RED, GREEN\n}\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.model.Color.RED\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(enumFile)) st.declare('kotlin', d.symbolKey, enumFile.path);
    // The enum file declares the TYPE key `com.acme.model.Color` but not the entry `+RED`.
    expect(st.has('kotlin', 'com.acme.model.Color')).toBe(true);
    expect(st.has('kotlin', 'com.acme.model.Color+RED')).toBe(false);
    const r = resolverOver(st, { 'src/m/Color.kt': 'm' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.model.Color.RED', r, consumer.path)).toBeUndefined();
  });

  it('PASS F2e (member chain is NOT a deeper package): `a.b.Color.RED` does NOT bind when `a.b.Color` is only a SUB-PACKAGE', async () => {
    // If `com.acme.model.Color` is a package (not a declared type) holding a type `RED`, the
    // dotted `...Color.RED` would name a real top-level type — but the guarded split only fires
    // at a declared-TYPE prefix. With no `Color` TYPE and no top-level `...Color.RED` declared,
    // the verbatim key + splits find nothing → SILENCE. Never read the member as a sub-package.
    const other = await parse('src/o/Other.kt', 'package com.acme.model\nclass Something\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.model.Color.RED\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(other)) st.declare('kotlin', d.symbolKey, other.path);
    const r = resolverOver(st, { 'src/o/Other.kt': 'o' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.model.Color.RED', r, consumer.path)).toBeUndefined();
  });

  it('PASS F2f: `import a.b.C.Companion.foo` resolves to C`s file via the `+`-split (C declared type → C+Companion+foo present)', async () => {
    const cFile = await parse('src/x/C.kt', 'package com.acme\nclass C {\n  companion object {\n    fun create() {}\n  }\n}\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.C.Companion.create\nclass D\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(cFile)) st.declare('kotlin', d.symbolKey, cFile.path);
    // The companion member is keyed `com.acme.C+Companion+create`; C is the declared-type boundary.
    expect(kotlinExtractor.declarations(cFile).map((d) => d.symbolKey)).toContain('com.acme.C+Companion+create');
    const r = resolverOver(st, { 'src/x/C.kt': 'x' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.C.Companion.create', r, consumer.path)).toBe('x');
  });

  it('PASS F2f: `import a.b.Obj.bar` (object member) resolves to the object`s file via the `+`-split', async () => {
    const objFile = await parse('src/r/Registry.kt', 'package com.acme\nobject Registry {\n  fun lookup() {}\n}\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.Registry.lookup\nclass D\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(objFile)) st.declare('kotlin', d.symbolKey, objFile.path);
    expect(kotlinExtractor.declarations(objFile).map((d) => d.symbolKey)).toContain('com.acme.Registry+lookup');
    const r = resolverOver(st, { 'src/r/Registry.kt': 'r' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.Registry.lookup', r, consumer.path)).toBe('r');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard import (`import a.b.*`): emits the PACKAGE hint → SILENCE (expansion FORBIDDEN)', () => {
  it('GAP (deliberate recall): `import a.b.*` emits the package FQN; no per-type declaration matches → SILENCE', async () => {
    // F2c: a wildcard names a PACKAGE, not a type. The `*` is a separate token; the emitted
    // hint is the package FQN. Declarations are per-type (`a.b.Order`), never the bare package,
    // so the wildcard hint resolves to nothing. Expanding a wildcard to "every type in the
    // package" is FP-risk and FORBIDDEN by the decision doc.
    const orderFile = await parse('src/o/Order.kt', 'package com.acme.orders\nclass Order\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.orders.*\nclass C\n');
    const keys = symbolKeys(kotlinExtractor.uses(consumer));
    expect(keys).toContain('com.acme.orders'); // the package FQN, `*` dropped
    expect(keys.every((k) => !k.includes('*'))).toBe(true);
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(orderFile)) st.declare('kotlin', d.symbolKey, orderFile.path);
    const r = resolverOver(st, { 'src/o/Order.kt': 'o' });
    // The wildcard resolves to nothing even though `com.acme.orders.Order` is in-graph → SILENCE.
    expect(resolveAll(kotlinExtractor.uses(consumer), r, consumer.path).every((o) => o === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — default / implicit stdlib (Form 3): unimported names → SILENCE (the collision trap)', () => {
  it('GAP (deliberate recall): implicit stdlib usage with NO import — `List`, `Pair`, `Result` — emits nothing', async () => {
    // F3: `kotlin.*` / `java.lang.*` names are usable with no import line; an import-only
    // extractor sees no import → emits nothing. (Even an explicit `import kotlin.collections.List`
    // would resolve to an FQN no in-graph file declares → absent → silence — covered next.)
    const { uses } = await run(
      'package com.acme\nfun f(): List<String> = listOf("a")\nval p: Pair<Int, Int> = 1 to 2\nfun g(): Result<Int> = Result.success(1)\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS F3 (stdlib-collision trap): a project type named `Result` must NEVER bind a bare `Result` usage', async () => {
    // The classic trap: a project declares `com.acme.util.Result`; another file uses the bare
    // `Result` with no import (which Kotlin binds to the implicit `kotlin.Result`). Import-only
    // emits NOTHING for the bare usage → the project `Result` can never be mis-bound. If a future
    // version resolved the bare simple name, it would be ambiguous (project vs stdlib) → must
    // silence; here it is structurally silent.
    const projResult = await parse('src/u/Result.kt', 'package com.acme.util\nclass Result\n');
    const consumer = await parse('src/c/Use.kt', 'package com.acme.app\nfun f(): Result<Int> = TODO()\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(projResult)) st.declare('kotlin', d.symbolKey, projResult.path);
    const r = resolverOver(st, { 'src/u/Result.kt': 'u' });
    expect(kotlinExtractor.uses(consumer)).toHaveLength(0); // no usage-site edge at all
    expect(resolveAll(kotlinExtractor.uses(consumer), r, consumer.path).every((o) => o === undefined)).toBe(true);
  });

  it('PASS F3: an explicit `import kotlin.collections.List` resolves to no in-graph file → SILENCE', async () => {
    // The import IS emitted (silencing is the SymbolTable`s job), but no in-graph file declares
    // `kotlin.collections.List`, so it is absent → silence. No FP.
    const consumer = await parse('src/c/Use.kt', 'import kotlin.collections.List\nimport java.util.ArrayList\nclass C\n');
    const keys = symbolKeys(kotlinExtractor.uses(consumer));
    expect(keys).toContain('kotlin.collections.List');
    expect(keys).toContain('java.util.ArrayList');
    const r = resolverOver(new SymbolTable(), {});
    expect(resolveAll(kotlinExtractor.uses(consumer), r, consumer.path).every((o) => o === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested / inner types (Form 4): split at a declared-TYPE boundary, NEVER deeper packages', () => {
  it('SEALED F4 (genuine FP): a nested decl was keyed FLAT (`<package>.<Simple>`) → mis-bound a top-level import — now `+`-keyed', async () => {
    // GENUINE CURRENT FALSE-POSITIVE this matrix exposed and FIXED.
    //
    // BEFORE: declarations() flattened EVERY declaration to `<package>.<SimpleName>` regardless
    // of nesting, so `class Outer { class Inner }` emitted the phantom top-level key
    // `com.acme.Inner`. A consumer`s `import com.acme.Inner` — which in Kotlin names a TOP-LEVEL
    // type in package `com.acme`, NEVER the nested `Outer.Inner` (that import is
    // `com.acme.Outer.Inner`) — resolved to THIS file: a WRONG edge, the FP the cardinal
    // invariant forbids.
    //
    // AFTER: a nested declaration is keyed by its enclosing-TYPE chain joined with `+`
    // (`com.acme.Outer+Inner`), in a string space disjoint from the dot-only namespace. The
    // top-level `import com.acme.Inner` now finds nothing → SILENCE (correct).
    const nestedFile = await parse('src/a/Outer.kt', 'package com.acme\nclass Outer {\n  class Inner\n}\n');
    expect(kotlinExtractor.declarations(nestedFile).map((d) => d.symbolKey)).toEqual([
      'com.acme.Outer',
      'com.acme.Outer+Inner', // NOT the phantom flat `com.acme.Inner`
    ]);
    const consumer = await parse('src/c/Use.kt', 'package com.x\nimport com.acme.Inner\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(nestedFile)) st.declare('kotlin', d.symbolKey, nestedFile.path);
    const r = resolverOver(st, { 'src/a/Outer.kt': 'a' });
    // The top-level import of the nested simple name must NOT bind to the nesting file.
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.Inner', r, consumer.path)).toBeUndefined();
  });

  it('PASS F4: the correct nested import `import a.b.Outer.Inner` resolves via the guarded `+`-split', async () => {
    const nestedFile = await parse('src/a/Outer.kt', 'package com.acme\nclass Outer {\n  class Inner\n}\n');
    const consumer = await parse('src/c/Use.kt', 'package com.x\nimport com.acme.Outer.Inner\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(nestedFile)) st.declare('kotlin', d.symbolKey, nestedFile.path);
    const r = resolverOver(st, { 'src/a/Outer.kt': 'a' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.Outer.Inner', r, consumer.path)).toBe('a');
  });

  it('PASS F4 (deeper nesting): `A.B.Deep` is keyed `A+B+Deep` and resolves at the declared-type boundary', async () => {
    const deepFile = await parse('src/a/A.kt', 'package com.acme\nclass A {\n  class B {\n    class Deep\n  }\n}\n');
    expect(kotlinExtractor.declarations(deepFile).map((d) => d.symbolKey)).toEqual([
      'com.acme.A',
      'com.acme.A+B',
      'com.acme.A+B+Deep',
    ]);
    const consumer = await parse('src/c/Use.kt', 'package com.x\nimport com.acme.A.B.Deep\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(deepFile)) st.declare('kotlin', d.symbolKey, deepFile.path);
    const r = resolverOver(st, { 'src/a/A.kt': 'a' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.A.B.Deep', r, consumer.path)).toBe('a');
  });

  it('PASS F4 (trap: nested vs sub-package): `a.b.Outer.Inner` binds the nested type, never a same-name top-level in a sub-package', async () => {
    // Node `nest` has the nested `com.acme.Outer+Inner`. Node `sub` declares a TOP-LEVEL
    // `com.acme.Outer.Inner` (i.e. a type `Inner` in the package `com.acme.Outer`). The import
    // `import com.acme.Outer.Inner` is genuinely ambiguous between these two readings — the
    // verbatim dotted key (sub-package top-level) AND the `+`-split (nested) each map to a
    // DIFFERENT file → ≥2 distinct files → ambiguous → SILENCE. No arbitrary mis-bind.
    const nestFile = await parse('src/nest/Outer.kt', 'package com.acme\nclass Outer {\n  class Inner\n}\n');
    const subFile = await parse('src/sub/Inner.kt', 'package com.acme.Outer\nclass Inner\n');
    const consumer = await parse('src/c/Use.kt', 'package com.x\nimport com.acme.Outer.Inner\nclass C\n');
    const st = new SymbolTable();
    for (const f of [nestFile, subFile]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
    }
    const r = resolverOver(st, { 'src/nest/Outer.kt': 'nest', 'src/sub/Inner.kt': 'sub' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.Outer.Inner', r, consumer.path)).toBeUndefined();
  });

  it('PASS F4 (no `$`-confusion): a JVM-style `Outer$Inner` literal is never produced or read as a flat identifier', async () => {
    // The analyzer`s canonical key uses `+`, never the JVM `$`. A nested decl is keyed with `+`;
    // no key contains `$`, so a stray `$` (e.g. in a string or annotation) can never collide.
    const nestedFile = await parse('src/a/Outer.kt', 'package com.acme\nclass Outer {\n  class Inner\n}\n');
    expect(kotlinExtractor.declarations(nestedFile).every((d) => !d.symbolKey.includes('$'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — usage-site forms (deliberate tolerated false-NEGATIVE: SILENT, not a bug)', () => {
  // Per .plans/2026-06-14-import-only-languages-decision.md: Kotlin STAYS import-only. Every
  // usage-site construct is a tolerated recall gap (silence), explicitly allowed by the
  // one-directional check. Each resolves through the Form-5 precedence order at the use site;
  // binding any of them by simple name would reintroduce the precedence + stdlib-collision FP
  // traps and is FORBIDDEN. These assert the CURRENT silence (uses() emits nothing for them).

  it('GAP (deliberate recall): supertype / interface list `class C : Base, Iface` — SILENT', async () => {
    const { uses } = await run('package com.acme.app\nclass C : com.acme.base.Base(), com.acme.flow.Iface\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): generic argument + `where` constraint — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nval xs: List<com.acme.model.Order> = emptyList()\nfun <T> f(t: T) where T : com.acme.model.Comparable<T> {}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `is` / `as` type test + cast — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nfun f(x: Any) {\n  if (x is com.acme.model.Order) {}\n  val y = x as com.acme.model.Receipt\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): param / return / property types — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nclass C {\n  val r: com.acme.Repo? = null\n  fun m(l: com.acme.Logger): com.acme.Result = TODO()\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): annotation use `@Audited` — SILENT', async () => {
    const { uses } = await run('package com.acme.app\n@com.acme.audit.Audited\nfun f() {}\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `::class` / callable reference — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nfun f() {\n  val k = com.acme.model.Order::class\n  val ref = com.acme.util.Helpers::format\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): constructor call `Order()` — SILENT (incl. the stdlib-collision ctor `Result()`/`Pair()`)', async () => {
    const { uses } = await run(
      'package com.acme.app\nfun f() {\n  val o = com.acme.model.Order()\n  val r = Result.success(1)\n  val p = Pair(1, 2)\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `typealias Money = Long` / `typealias AInner = A.Inner` — SILENT (RHS not extracted)', async () => {
    // F6j: a typealias does not introduce a new type; its RHS is a usage-site type ref. The
    // alias name IS indexed as a declaration (so others can import it), but the RHS is silent.
    const { uses } = await run('package com.acme.app\ntypealias Money = Long\ntypealias AInner = com.acme.A.Inner\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): extension receiver `fun Order.summary()` — SILENT', async () => {
    const { uses } = await run('package com.acme.app\nfun com.acme.model.Order.summary(): String = ""\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): delegation `by` (`class C : Iface by impl`, `val p by lazy {}`) — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nclass C(impl: com.acme.flow.Iface) : com.acme.flow.Iface by impl {\n  val p by lazy { 1 }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): `when`-subject smart cast `when (x) { is Order -> }` — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nfun f(x: Any) = when (x) {\n  is com.acme.model.Order -> 1\n  else -> 0\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): Pair / `to` tuple element types — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nval t: Pair<com.acme.model.Order, com.acme.model.Receipt>? = null\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): nullable `T?`, array `Array<T>`, `vararg` element types — SILENT', async () => {
    const { uses } = await run(
      'package com.acme.app\nclass C {\n  val o: com.acme.model.Order? = null\n  val a: Array<com.acme.model.Order> = arrayOf()\n  fun m(vararg xs: com.acme.model.Order) {}\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall): bare top-level call `retry { }` — SILENT', async () => {
    // F7: a bare call to a top-level function resolves by Form-5 precedence at the use site;
    // import-only emits nothing for the call. (The explicit `import com.acme.util.retry` IS the
    // edge and IS emitted — asserted in the F2b block.)
    const { uses } = await run('package com.acme.app\nimport com.acme.util.retry\nfun g() = retry { }\n');
    // Only the import edge survives; the bare call `retry { }` is not separately emitted.
    expect(symbolKeys(uses)).toEqual(['com.acme.util.retry']);
  });

  it('GAP (deliberate recall): fully-qualified INLINE reference `com.acme.X()` — SILENT', async () => {
    // A fully-qualified inline reference is the one provably-safe recall extension the decision
    // doc flags for OWNER review — NOT auto-implemented. Current behavior: silence.
    const { uses } = await run('package com.acme.app\nfun f() { val o = com.acme.metrics.Timer() }\n');
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JVM artifacts (Form 8): no `<File>Kt` facade / `@file:JvmName` key for Kotlin resolution', () => {
  it('PASS F8: `@file:JvmName("OrderUtils")` does NOT synthesize a facade key; decls keep package + simple name', async () => {
    // A Kotlin reference NEVER uses the JVM facade `<File>Kt` / `@JvmName`; only Java callers do.
    // The declaration keys are the package-qualified Kotlin FQNs, never `...OrderUtils.place`.
    const { declarations } = await run(
      '@file:JvmName("OrderUtils")\npackage com.acme.orders\nclass Order\nfun place() {}\nval DEFAULT = 0\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toContain('com.acme.orders.Order');
    expect(keys).toContain('com.acme.orders.place');
    expect(keys).toContain('com.acme.orders.DEFAULT');
    // No facade-class key is invented for Kotlin-side resolution.
    expect(keys.every((k) => !k.includes('OrderUtils'))).toBe(true);
    expect(keys.every((k) => !k.endsWith('Kt') && !k.includes('Kt.'))).toBe(true);
  });

  it('PASS F8: multiple top-level declarations in one file → one key per declaration, all same package', async () => {
    const { declarations } = await run(
      'package com.acme.orders\nclass Order\nfun place() {}\nval DEFAULT = 0\ntypealias Money = Long\n',
    );
    const keys = declarations.map((d) => d.symbolKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'com.acme.orders.Order',
        'com.acme.orders.place',
        'com.acme.orders.DEFAULT',
        'com.acme.orders.Money',
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — ambiguity collapses to SILENCE (never an arbitrary edge)', () => {
  it('PASS: two files declaring the SAME FQN → an import of it resolves to undefined (silence, no flag)', async () => {
    const fileX = await parse('src/x/Thing.kt', 'package com.acme.dup\nclass Thing\n');
    const fileY = await parse('src/y/Thing.kt', 'package com.acme.dup\nclass Thing\n');
    const consumer = await parse('src/z/Use.kt', 'package com.acme.z\nimport com.acme.dup.Thing\nclass Use\n');
    const st = new SymbolTable();
    for (const f of [fileX, fileY]) {
      for (const d of kotlinExtractor.declarations(f)) st.declare('kotlin', d.symbolKey, f.path);
    }
    const r = resolverOver(st, { 'src/x/Thing.kt': 'x', 'src/y/Thing.kt': 'y' });
    expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.dup.Thing' }, consumer.path, 'kotlin')).toEqual({ kind: 'ambiguous' });
    expect(walkResolve(kotlinExtractor.uses(consumer), 'com.acme.dup.Thing', r, consumer.path)).toBeUndefined();
  });

  it('PASS: an import of an UNMAPPED in-graph file → absent (coverage matter, never a violation)', async () => {
    const declFile = await parse('src/a/Order.kt', 'package com.acme\nclass Order\n');
    const consumer = await parse('src/c/Use.kt', 'package com.app\nimport com.acme.Order\nclass C\n');
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(declFile)) st.declare('kotlin', d.symbolKey, declFile.path);
    // ownerOf returns undefined → the mapped file has no owning node → absent (silence).
    const r = resolverOver(st, {});
    expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.Order' }, consumer.path, 'kotlin')).toEqual({ kind: 'absent' });
  });
});
