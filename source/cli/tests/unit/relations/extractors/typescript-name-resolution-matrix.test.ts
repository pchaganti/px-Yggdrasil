import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { typescriptExtractor } from '../../../../src/relations/extractors/typescript.js';
import { resolveTsPath } from '../../../../src/relations/extractors/typescript-resolve.js';

/**
 * TYPESCRIPT / JAVASCRIPT IMPORT-PATH IDENTIFICATION MATRIX — characterization, one `it()`
 * per distinct TS/JS import/export identification form. Each test realizes the CONCRETE
 * source for that exact case and asserts the SPEC-CORRECT, zero-FP outcome. For every
 * resolving PATH form the same-basename FP-trap variant (a same-named file in ANOTHER node
 * that must NOT be chosen) sits beside the positive.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * TS/JS resolves imports to FILES by PATH (relative specifiers, then — out of scope for v1 —
 * tsconfig baseUrl/paths and package exports), NOT by namespace-relative simple-NAME binding.
 * So the §-precedence simple-name trap that drives the symbol languages does not apply here.
 * The FP risks are module-resolution-specific: a TYPE-ONLY import/export emitting a runtime
 * edge, a non-literal dynamic import emitting an edge, a wrong extension/index pick, a bare
 * (external) specifier mis-resolving. The cardinal invariant — ZERO false positives, a hard
 * wall with no adopter waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here:
 *   B1  Only a module-specifier-bearing statement is an edge: static import, re-export WITH a
 *       source, `import x = require(...)`, `require(...)`, `export = require(...)`, or a dynamic
 *       `import(...)` with a STRING-LITERAL specifier. Usage-site nodes never refine an edge.
 *   B2  Only RELATIVE specifiers ('.'/'/') become hints; bare specifiers (npm packages, node
 *       builtins, tsconfig path aliases) are SILENT — they never resolve to an in-graph node.
 *   B3  TYPE-ONLY forms erase at compile time and are NOT runtime dependencies → SILENT. This
 *       covers `import type`, all-inline-type clauses (cb6aa52b), `export type { } from`, and
 *       the namespace/star type re-exports `export type * [as T] from` (SEALED below).
 *   B4  A non-literal dynamic import (`import(`...${v}`)`, `import(v)`, `import('a'+v)`) is not
 *       statically analyzable → SILENT (an emitted edge there would be a guess = FP).
 *   B5  Path resolution picks the file under the importing module by RELATIVE JOIN +
 *       extension/index rules; a same-basename file in another directory is structurally
 *       unreachable (the join pins the directory), so a same-name trap cannot mis-bind.
 *   B6  candidate-parity invariant: every emitted reference is a ONE-ELEMENT candidate group
 *       (path languages never widen). Asserted at the end so the matrix can't break parity.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine current false-positive this matrix exposed and FIXED (the
 *           `export type * [as T] from` namespace/star type-only re-export block: the grammar
 *           wraps the leading `type` keyword in an ERROR node, so the whole-statement type
 *           guard missed it and emitted a RUNTIME edge for a compile-time-only re-export —
 *           now the ERROR-wrapped `type` marker is recognized and the edge is silent).
 */

const run = (code: string, ext = '.ts', lang = 'typescript') =>
  runExtractor(typescriptExtractor, lang, ext, code);

/** The path specifiers emitted for a file — each import-bearing statement's specifier. */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — relative imports (the specifier IS the edge; resolves to a FILE by path)', () => {
  it('PASS B1: `import { X } from "./x"` → emits the relative specifier `./x`', async () => {
    expect(specs((await run(`import { X } from './x';`)).uses)).toEqual(['./x']);
  });

  it('PASS B1: parent-relative `import { Y } from "../y"` → emits `../y`', async () => {
    expect(specs((await run(`import { Y } from '../y';`)).uses)).toEqual(['../y']);
  });

  it('PASS B1: default + named binding `import def, { a } from "./m"` → exactly one edge', async () => {
    expect(specs((await run(`import def, { a } from './m';`)).uses)).toEqual(['./m']);
  });

  it('PASS B1: side-effect import `import "./polyfill"` → emits `./polyfill` (real file dependency)', async () => {
    // No binding, but the module IS evaluated at runtime — a genuine dependency edge.
    expect(specs((await run(`import './polyfill';`)).uses)).toEqual(['./polyfill']);
  });

  it('PASS B1: namespace import `import * as ns from "./m"` → emits `./m`', async () => {
    expect(specs((await run(`import * as ns from './m';`)).uses)).toEqual(['./m']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — extension / index resolution (relative join pins the directory; no same-name mis-bind)', () => {
  // The resolver is exercised directly over a fixed known-set: it picks the file under the
  // importing module's directory. A same-basename file in ANOTHER directory (the trap) is
  // never in the candidate set, so it can never be chosen (B5).
  const FROM = 'src/a/use.ts';
  const known = new Set([
    'src/a/x.ts',
    'src/a/widget.tsx',
    'src/a/legacy.js',
    'src/a/esm.ts', // the .ts that an ESM `.js` specifier rewrites to
    'src/a/dir/index.ts',
    'src/a/dts/types.d.ts',
    // TRAP siblings — same basename, DIFFERENT directory; the relative join must never reach them.
    'src/other/x.ts',
    'src/other/widget.tsx',
    'src/other/esm.ts',
  ]);
  const exists = (p: string) => known.has(p);

  it('PASS B5: `.ts` extension resolution — `./x` → `src/a/x.ts`, never the sibling `src/other/x.ts`', () => {
    expect(resolveTsPath('./x', FROM, exists)).toBe('src/a/x.ts');
  });

  it('PASS B5: `.tsx` extension resolution — `./widget` → `src/a/widget.tsx`, never `src/other/widget.tsx`', () => {
    expect(resolveTsPath('./widget', FROM, exists)).toBe('src/a/widget.tsx');
  });

  it('PASS B5: `.js` source fallback — `./legacy` → `src/a/legacy.js` when no `.ts` exists', () => {
    expect(resolveTsPath('./legacy', FROM, exists)).toBe('src/a/legacy.js');
  });

  it('PASS B5: ESM `.js`-specifier-points-to-`.ts` (NodeNext) — `./esm.js` → `src/a/esm.ts`', () => {
    // The classic NodeNext case: the SOURCE imports `./esm.js`; only `./esm.ts` exists on disk.
    // The rewrite table maps `.js` → try `.ts` first. Trap sibling `src/other/esm.ts` unreachable.
    expect(resolveTsPath('./esm.js', FROM, exists)).toBe('src/a/esm.ts');
  });

  it('PASS B5: directory `index.ts` resolution — `./dir` → `src/a/dir/index.ts`', () => {
    expect(resolveTsPath('./dir', FROM, exists)).toBe('src/a/dir/index.ts');
  });

  it('GAP (deliberate recall): a `.d.ts` declaration file is NOT a probed candidate — `./dts/types` → SILENCE', () => {
    // The resolver probes `.ts/.tsx/.js/.jsx/.mjs/.cjs` + index; `.d.ts` is a declaration-only
    // (type) artifact with no runtime module, so it is intentionally not in the candidate list.
    // Missing it is a tolerated false-NEGATIVE (a `.d.ts` import is type-only anyway), never an FP.
    expect(resolveTsPath('./dts/types', FROM, exists)).toBeUndefined();
  });

  it('PASS B5: a specifier under no existing candidate → SILENCE (never an arbitrary same-name pick)', () => {
    expect(resolveTsPath('./nope', FROM, exists)).toBeUndefined();
  });

  it('PASS B5: `..`-normalization stays inside the join — `./../a/x.js` → `src/a/x.ts`', () => {
    expect(resolveTsPath('./../a/x.js', FROM, exists)).toBe('src/a/x.ts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — bare / package specifiers + tsconfig path aliases (external → SILENT, the alias-collision trap)', () => {
  it('PASS B2: bare package `import x from "lodash"` → SILENT (external, not in-repo)', async () => {
    expect(await run(`import x from 'lodash';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B2: node builtin `import path from "node:path"` → SILENT', async () => {
    expect(await run(`import path from 'node:path';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('GAP (deliberate recall): tsconfig path alias `import { X } from "@app/x"` → SILENT (paths/baseUrl out of scope for v1)', async () => {
    // tsconfig `paths`/`baseUrl` aliasing is OUT OF SCOPE for v1 — a `@app/*` specifier does
    // not start with '.'/'/', so it is treated as bare → SILENT. This MISSES a real in-repo
    // dependency (a tolerated false-NEGATIVE), but it can never mis-map: the alias is dropped
    // BEFORE any resolution, so there is no path to a wrong file.
    expect(await run(`import { X } from '@app/x';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS (alias-collision trap): an `@app`-style alias is never confused with a node_modules package — both SILENT', () => {
    // The collision the spec warns about: a project alias whose first segment matches a package
    // name. Because BOTH a bare package name and an unresolved alias are non-relative, the
    // resolver returns undefined for each — there is no mechanism by which the alias could
    // resolve to the wrong (package) file. (And the resolver never even sees node_modules.)
    const exists = (p: string) => p === 'src/app/x.ts';
    // A non-relative specifier is rejected up front regardless of what exists on disk.
    expect(resolveTsPath('@app/x', 'src/a/use.ts', exists)).toBeUndefined();
    expect(resolveTsPath('lodash', 'src/a/use.ts', exists)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-only forms (compile-time erasure → SILENT; cb6aa52b seal must hold)', () => {
  it('PASS B3: whole-statement `import type { T } from "./t"` → SILENT, sibling value import unaffected', async () => {
    const s = specs((await run(`import type { T } from './t';\nimport { a } from './ab';`)).uses);
    expect(s).not.toContain('./t');
    expect(s).toContain('./ab');
  });

  it('PASS B3: whole-statement namespace type import `import type * as T from "./t"` → SILENT', async () => {
    const s = specs((await run(`import type * as T from './t';\nimport { a } from './ab';`)).uses);
    expect(s).not.toContain('./t');
    expect(s).toContain('./ab');
  });

  it('PASS B3: all-inline-type named import `import { type A, type B } from "./t"` → SILENT (cb6aa52b)', async () => {
    expect(await run(`import { type A, type B } from './t';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B3: a single all-inline-type named import `import { type A } from "./t"` → SILENT (cb6aa52b)', async () => {
    expect(await run(`import { type A } from './t';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B3: MIXED inline-type import `import { type A, b } from "./m"` → KEEPS exactly one edge', async () => {
    // `b` is a runtime binding; the `type` modifier sits inside the specifier, not as a
    // statement-level token — the statement still has a runtime dependency.
    expect(specs((await run(`import { type A, b } from './m';`)).uses)).toEqual(['./m']);
  });

  it('PASS B3: all-inline-type import with a runtime DEFAULT `import def, { type A } from "./m"` → KEEPS the edge', async () => {
    expect(specs((await run(`import def, { type A } from './m';`)).uses)).toEqual(['./m']);
  });

  it('PASS B3: whole-statement type re-export `export type { X } from "./t"` → SILENT, value re-export unaffected', async () => {
    const s = specs((await run(`export type { X } from './t';\nexport { v } from './value';`)).uses);
    expect(s).not.toContain('./t');
    expect(s).toContain('./value');
  });

  it('PASS B3: all-inline-type named re-export `export { type A, type B } from "./t"` → SILENT (cb6aa52b)', async () => {
    expect(await run(`export { type A, type B } from './t';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B3: MIXED inline-type re-export `export { type A, b } from "./m"` → KEEPS exactly one edge', async () => {
    expect(specs((await run(`export { type A, b } from './m';`)).uses)).toEqual(['./m']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-only namespace/star re-export (SEALED genuine FP: ERROR-wrapped `type` marker)', () => {
  it('SEALED B3 (genuine FP): `export type * as T from "./t"` → SILENT (was a RUNTIME edge)', async () => {
    // GENUINE CURRENT FALSE-POSITIVE this matrix exposed and FIXED.
    //
    // `export type * as T from './t'` is valid TypeScript (≥ 5.0): a TYPE-ONLY namespace
    // re-export that erases at compile time and carries NO runtime dependency on `./t`.
    //
    // BEFORE: the current tree-sitter grammar does not model `export type *`, so it parsed the
    // leading `type` keyword into an `ERROR` node (a direct child of export_statement, before
    // the `namespace_export`). The whole-statement type guard only looked for a bare `type`
    // token, missed the ERROR-wrapped one, found no `export_clause` for the inline-type guard
    // to inspect either, and EMITTED a runtime edge to `./t` — a false positive: the importing
    // module has no runtime dependency on `./t`. With `./t` mapped to a node the consumer
    // declares no relation to, that is a spurious `relation-undeclared-dependency` refusal.
    //
    // AFTER: the guard recognizes an `ERROR` node whose text is exactly `type` as the
    // whole-statement type marker (matched verbatim so an unrelated parse error never trips it),
    // so the statement is silenced. SEALED.
    expect(await run(`export type * as T from './t';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('SEALED B3 (genuine FP): `export type * from "./t"` (no `as`) → SILENT (was a RUNTIME edge)', async () => {
    // Same FP shape with no alias: `export type *` is parsed with the same ERROR-wrapped `type`
    // before a bare `*`. Also a compile-time-only re-export → now silent.
    expect(await run(`export type * from './t';`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B1 (the seal does NOT over-silence the VALUE namespace re-export): `export * as ns from "./ns"` → KEEPS the edge', async () => {
    // The trap beside the seal: `export * as ns from './ns'` (no `type`) is a RUNTIME namespace
    // re-export — a real dependency. `export type * as` is not the same construct; the seal must
    // fire ONLY when the leading `type` marker is present, never for the bare value form.
    expect(specs((await run(`export * as ns from './ns';`)).uses)).toEqual(['./ns']);
  });

  it('PASS B1 (the seal does NOT over-silence value star re-export): `export * from "./x"` → KEEPS the edge', async () => {
    expect(specs((await run(`export * from './x';`)).uses)).toEqual(['./x']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — value re-exports (real runtime dependencies → resolve)', () => {
  it('PASS B1: `export { X } from "./x"` → emits `./x` (value re-export, real dependency)', async () => {
    expect(specs((await run(`export { X } from './x';`)).uses)).toEqual(['./x']);
  });

  it('PASS B1: empty re-export clause `export {} from "./empty"` → KEEPS the edge (not provably type-only)', async () => {
    // Zero specifiers — conservatively NOT treated as type-only; the edge is kept.
    expect(specs((await run(`export {} from './empty';`)).uses)).toEqual(['./empty']);
  });

  it('PASS B1: a LOCAL export (no `from`) is NOT an edge — `export const local = 1` → SILENT', async () => {
    // No `source` field on a local export — nothing to depend on.
    expect(await run(`export const local = 1;`).then((r) => r.uses)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic import / require / CJS export-assignment (literal resolves; non-literal SILENT)', () => {
  it('PASS B1: dynamic `import("./d")` with a string literal → emits `./d`', async () => {
    expect(specs((await run(`const d = import('./d');`)).uses)).toEqual(['./d']);
  });

  it('GAP/B4 (deliberate recall): template-literal dynamic import `import(`./x-${v}`)` → SILENT (not statically analyzable)', async () => {
    expect(await run('const d = import(`./x-${v}`);').then((r) => r.uses)).toHaveLength(0);
  });

  it('GAP/B4 (deliberate recall): identifier dynamic import `import(v)` → SILENT', async () => {
    expect(await run(`const d = import(v);`).then((r) => r.uses)).toHaveLength(0);
  });

  it('GAP/B4 (deliberate recall): concatenation dynamic import `import("./a" + v)` → SILENT (binary_expression, not a literal)', async () => {
    // A leading string literal `'./a' + v` is NOT a plain string node — emitting `./a` would be
    // a guess at the runtime target = an FP. The non-string-literal arg is dropped → silence.
    expect(await run(`const d = import('./a' + v);`).then((r) => r.uses)).toHaveLength(0);
  });

  it('GAP/B4 (deliberate recall): dynamic import of an EMPTY string `import("")` → SILENT (non-relative empty specifier)', async () => {
    expect(await run(`const d = import('');`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B1: CJS `require("./a")` → emits `./a`', async () => {
    expect(specs((await run(`const a = require('./a');`)).uses)).toEqual(['./a']);
  });

  it('PASS B1: `require()` with no argument → SILENT (no specifier)', async () => {
    expect(await run(`const x = require();`).then((r) => r.uses)).toHaveLength(0);
  });

  it('GAP (deliberate recall): member-callee `require.resolve("./x")` → SILENT (callee is not the bare `require` identifier)', async () => {
    // Only a callee that is the bare identifier `require` (or a dynamic `import`) is an edge.
    // `require.resolve` is a member_expression callee → not matched → silent. (It returns a path
    // string, not a module value, so missing it is a tolerated recall gap, never an FP.)
    expect(await run(`const p = require.resolve('./x');`).then((r) => r.uses)).toHaveLength(0);
  });

  it('PASS B1: TS `import b = require("./b")` (import-equals-require) → emits `./b`', async () => {
    expect(specs((await run(`import b = require('./b');`)).uses)).toEqual(['./b']);
  });

  it('PASS B1: CJS `export = require("./e")` (export-assignment of a require) → emits `./e`', async () => {
    // `export = require('./e')` re-exports a required module — a real runtime dependency. The
    // edge comes from the nested `require('./e')` call expression, not the export-assignment node.
    expect(specs((await run(`export = require('./e');`)).uses)).toEqual(['./e']);
  });

  it('GAP (deliberate recall): `export = localIdent` (export-assignment of a binding, no require) → SILENT', async () => {
    // `import x from './x'; export = x;` — the import IS the edge (`./x`); the `export = x`
    // assignment carries no specifier of its own, so it adds nothing. No double-count, no FP.
    expect(specs((await run(`import x from './x';\nexport = x;`)).uses)).toEqual(['./x']);
  });

  it('PASS: ordinary call / member call taking a string arg is NOT an edge — `foo("./x")`, `obj.m("./y")` → SILENT', async () => {
    expect(await run(`foo('./x');\nobj.method('./y');`).then((r) => r.uses)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JavaScript (no type syntax): the same path forms resolve, no crash', () => {
  it('PASS B1: `.js` file — `import x from "./x"` + `require("./y")` → two edges', async () => {
    const s = specs((await run(`import x from './x';\nconst y = require('./y');`, '.js', 'javascript')).uses);
    expect(s).toContain('./x');
    expect(s).toContain('./y');
    expect(s).toHaveLength(2);
  });

  it('PASS B2: `.js` file — bare specifier `import x from "lodash"` → SILENT', async () => {
    expect(await run(`import x from 'lodash';`, '.js', 'javascript').then((r) => r.uses)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — candidate-parity invariant (path languages emit ONE-ELEMENT groups, never widen)', () => {
  it('PASS B6: every emitted reference across mixed import/export/dynamic forms is a one-element group', async () => {
    const { uses } = await run(
      [
        `import { X } from './x';`,
        `import * as ns from './m';`,
        `import './polyfill';`,
        `export { v } from './value';`,
        `export * from './star';`,
        `export * as e from './estar';`,
        `const d = import('./d');`,
        `const a = require('./a');`,
        `import b = require('./b');`,
      ].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });
});
