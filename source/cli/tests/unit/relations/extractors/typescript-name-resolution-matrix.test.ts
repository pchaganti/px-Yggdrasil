import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * TYPESCRIPT / TSX / JAVASCRIPT NAME-RESOLUTION IDENTIFICATION MATRIX — one
 * runCase-backed test per identification case. Every case is backed by a
 * reference-catalogue doc (reference/relations/typescript/<id>.md): the embedded
 * fixture code + the documented `## Expect` outcome are the single source of truth,
 * asserted end-to-end through the REAL relation pass (extractor + relative-specifier
 * path resolver) by runCase. The two relations aspects (reference/relations/case-has-test
 * + case-is-tested) enforce the 1:1 catalogue↔test correspondence, so this file cannot
 * drift from the catalogue.
 *
 * THE GROUP B (path-axis) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * TS/JS resolves imports to FILES by PATH — a cross-module reference is ALWAYS established
 * by a statement bearing a module SPECIFIER (a string literal): a static import, a
 * re-export with a source, `import x = require(...)`, `require(...)`, `export = require(...)`,
 * or a dynamic `import(...)` with a string-literal argument. The specifier resolves to a file
 * by relative join onto the importing file's directory plus extension/index probing; the local
 * binding form (default / named / namespace / side-effect) is irrelevant. There is no
 * symbol-table name-axis to leak — the §-precedence simple-name trap of the symbol languages
 * does not exist here. The cardinal invariant — ZERO false positives, a hard wall with no
 * adopter waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The catalogue covers the research enumeration (.plans/2026-06-15-typescript-name-resolution-
 * research.md): the edge-bearing static-import forms (default / named / namespace / side-effect
 * / default+named), the type-only erasure silences (whole-statement + all-inline `import type`,
 * `export type { } from`, and the SEALED `export type * [as ns] from`) beside the runtime-binding
 * keeps (mixed inline-type, runtime default), the value re-exports (named / star / namespace /
 * empty), the require axis (`require`, `import = require`, `export = require`, no-arg + member
 * `require.resolve` silences), the dynamic-import axis (literal edge vs template / identifier /
 * concatenation / empty silences), the resolution axis (`.ts`/`.tsx`/`.js`/NodeNext-`.js`→`.ts`/
 * directory-index edges, the same-name sibling trap, the unmapped/intra-node silences), and the
 * external/config silences (bare specifier, tsconfig alias, package.json `#imports`, ambient
 * `declare module`, triple-slash, `import.meta.resolve`, JSON import-attribute). Each case
 * asserts the SPEC-CORRECT, zero-FP outcome: an edge to the file the specifier names, or silence.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — static import forms (the specifier IS the edge; binding form is irrelevant)', () => {
  it('typescript-default-import-edge', () => runCase('typescript-default-import-edge'));
  it('typescript-named-import-edge', () => runCase('typescript-named-import-edge'));
  it('typescript-namespace-import-edge', () => runCase('typescript-namespace-import-edge'));
  it('typescript-side-effect-import-edge', () => runCase('typescript-side-effect-import-edge'));
  it('typescript-default-plus-named-import-edge', () =>
    runCase('typescript-default-plus-named-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — type-only erasure (compile-time-only → SILENT) vs runtime-binding keeps', () => {
  it('typescript-import-type-whole-statement-silence', () =>
    runCase('typescript-import-type-whole-statement-silence'));
  it('typescript-import-type-namespace-silence', () =>
    runCase('typescript-import-type-namespace-silence'));
  it('typescript-all-inline-type-import-silence', () =>
    runCase('typescript-all-inline-type-import-silence'));
  it('typescript-mixed-inline-type-import-edge', () =>
    runCase('typescript-mixed-inline-type-import-edge'));
  it('typescript-inline-type-runtime-default-edge', () =>
    runCase('typescript-inline-type-runtime-default-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — re-exports (value re-exports resolve; type-only re-exports → SILENT, incl. the SEALED star)', () => {
  it('typescript-named-reexport-edge', () => runCase('typescript-named-reexport-edge'));
  it('typescript-star-reexport-edge', () => runCase('typescript-star-reexport-edge'));
  it('typescript-namespace-reexport-edge', () => runCase('typescript-namespace-reexport-edge'));
  it('typescript-empty-reexport-edge', () => runCase('typescript-empty-reexport-edge'));
  it('typescript-export-type-whole-statement-silence', () =>
    runCase('typescript-export-type-whole-statement-silence'));
  it('typescript-all-inline-type-reexport-silence', () =>
    runCase('typescript-all-inline-type-reexport-silence'));
  it('typescript-mixed-inline-type-reexport-edge', () =>
    runCase('typescript-mixed-inline-type-reexport-edge'));
  it('typescript-export-type-star-reexport-silence', () =>
    runCase('typescript-export-type-star-reexport-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — require axis (require / import-equals / export-assignment; no-arg + member silences)', () => {
  it('typescript-require-edge', () => runCase('typescript-require-edge'));
  it('typescript-import-equals-require-edge', () =>
    runCase('typescript-import-equals-require-edge'));
  it('typescript-export-equals-require-edge', () =>
    runCase('typescript-export-equals-require-edge'));
  it('typescript-require-no-argument-silence', () =>
    runCase('typescript-require-no-argument-silence'));
  it('typescript-require-resolve-member-silence', () =>
    runCase('typescript-require-resolve-member-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic import (string literal resolves; non-literal arguments → SILENT)', () => {
  it('typescript-dynamic-import-literal-edge', () =>
    runCase('typescript-dynamic-import-literal-edge'));
  it('typescript-dynamic-import-template-silence', () =>
    runCase('typescript-dynamic-import-template-silence'));
  it('typescript-dynamic-import-non-literal-silence', () =>
    runCase('typescript-dynamic-import-non-literal-silence'));
  it('typescript-import-meta-resolve-silence', () =>
    runCase('typescript-import-meta-resolve-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — relative resolution (relative join pins the directory; extension / index probing)', () => {
  it('typescript-relative-resolves-tsx-edge', () =>
    runCase('typescript-relative-resolves-tsx-edge'));
  it('typescript-relative-resolves-js-edge', () =>
    runCase('typescript-relative-resolves-js-edge'));
  it('typescript-nodenext-js-to-ts-edge', () => runCase('typescript-nodenext-js-to-ts-edge'));
  it('typescript-directory-index-edge', () => runCase('typescript-directory-index-edge'));
  it('typescript-sibling-same-name-trap-edge', () =>
    runCase('typescript-sibling-same-name-trap-edge'));
  it('typescript-unmapped-target-silence', () => runCase('typescript-unmapped-target-silence'));
  it('typescript-intra-node-import-silence', () => runCase('typescript-intra-node-import-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — external / config specifiers + usage sites (out of scope or not a specifier → SILENT)', () => {
  it('typescript-bare-specifier-silence', () => runCase('typescript-bare-specifier-silence'));
  it('typescript-tsconfig-alias-silence', () => runCase('typescript-tsconfig-alias-silence'));
  it('typescript-package-subpath-imports-silence', () =>
    runCase('typescript-package-subpath-imports-silence'));
  it('typescript-ambient-declare-module-silence', () =>
    runCase('typescript-ambient-declare-module-silence'));
  it('typescript-triple-slash-reference-silence', () =>
    runCase('typescript-triple-slash-reference-silence'));
  it('typescript-import-attribute-json-silence', () =>
    runCase('typescript-import-attribute-json-silence'));
  it('typescript-usage-site-no-import-silence', () =>
    runCase('typescript-usage-site-no-import-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JavaScript (no type syntax): the same path forms resolve, no crash', () => {
  it('typescript-javascript-import-require-edge', () =>
    runCase('typescript-javascript-import-require-edge'));
});
