import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * GO NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/go/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + import-path resolver) by runCase. The two relations
 * aspects (reference/relations/case-has-test + case-is-tested) enforce the 1:1
 * catalogue↔test correspondence, so this file cannot drift from the catalogue.
 *
 * THE GROUP B (path-axis) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Go resolves an import to a PACKAGE DIRECTORY by import PATH — the go.mod `module`
 * path is the prefix, the remaining path segments name the directory under the module
 * root, and a representative production `.go` file in that directory is the edge target.
 * Go has NO inline-FQN form: a cross-package reference is ALWAYS established by an
 * `import` declaration whose operand is the import PATH; usage-site selectors
 * (`pkg.Func`), embedding, generic instantiation, and range-over-func carry no new
 * edge (the import already established the dependency). The local binding form — plain,
 * aliased, blank `_`, dot `.`, raw-string — is irrelevant to the edge; every form names
 * the same real package path. The cardinal invariant — ZERO false positives, a hard wall
 * with no adopter waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The catalogue covers the research enumeration (.plans/2026-06-15-go-name-resolution-
 * research.md): the edge-bearing import forms (A1 single, A2 grouped, A3 alias, A4 dot,
 * A5 blank, A1 raw-string), and the silences — stdlib (B4) and external-module (B5)
 * module-prefix-gate misses, the two unmodeled-rewrite recall gaps the research flagged
 * as documentation holes (F4 `replace` directive, F5 `go.work` workspace), an uncovered
 * in-module package (B8/D5), and an intra-package same-node reference (E1/E2). Each case
 * asserts the SPEC-CORRECT, zero-FP outcome: an edge to the directory the path names, or
 * silence.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (the import PATH is the edge → directory by full path)', () => {
  it('go-single-import-edge', () => runCase('go-single-import-edge'));
  it('go-grouped-import-edge', () => runCase('go-grouped-import-edge'));
  it('go-raw-string-import-edge', () => runCase('go-raw-string-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — local-binding forms (alias / blank / dot): the binding is irrelevant, the PATH is the edge', () => {
  it('go-aliased-import-edge', () => runCase('go-aliased-import-edge'));
  it('go-blank-import-edge', () => runCase('go-blank-import-edge'));
  it('go-dot-import-edge', () => runCase('go-dot-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — stdlib / external (no module-prefix match → SILENCE, the most important FP guard)', () => {
  it('go-stdlib-import-silence', () => runCase('go-stdlib-import-silence'));
  it('go-external-module-import-silence', () => runCase('go-external-module-import-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Unmodeled rewrites the research flagged as documentation holes: the `module`-only
// go.mod reader ignores `replace`, and no `go.work` handling exists. Both correctly
// resolve to SILENCE (a tolerated false-NEGATIVE that can never mis-bind), now pinned.
describe('MATRIX — unmodeled rewrites (replace / go.work): out-of-module → SILENCE, never a guessed edge', () => {
  it('go-replace-directive-silence', () => runCase('go-replace-directive-silence'));
  it('go-go-work-workspace-silence', () => runCase('go-go-work-workspace-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — coverage / granularity silences (uncovered package, intra-package reference)', () => {
  it('go-unmapped-package-silence', () => runCase('go-unmapped-package-silence'));
  it('go-intra-package-silence', () => runCase('go-intra-package-silence'));
});
