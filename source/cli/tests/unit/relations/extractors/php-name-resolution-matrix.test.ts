import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * PHP NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/php/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + PSR-4 path resolver + owner index) by runCase. The two
 * relations aspects (reference/relations/case-has-test + case-is-tested) enforce the 1:1
 * catalogue↔test correspondence, so this file cannot drift from the catalogue.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the PHP
 * extractor establishes a dependency edge from a `use` CLASS import — whose operand is a
 * fully-qualified name resolved to a file via composer PSR-4 — and from a leading-backslash
 * INLINE class reference in a class-autoload position (the one provably-shadow-free recall
 * extension; `\App\X` names the absolute type independent of namespace/use). Backslash-LESS
 * (namespace-relative) usage-site names, `use function`/`use const`, function-call and
 * bare-constant FQNs, and every dynamic form stay SILENT — a deliberate tolerated false-
 * NEGATIVE. The cardinal invariant — ZERO false positives — outranks recall.
 *
 * The catalogue covers the full research enumeration (.plans/2026-06-15-php-name-resolution-
 * research.md): every `use` import form (PART A), PSR-4 path resolution incl. longest-prefix
 * and multi-root ambiguity (PART C), every namespace-relative usage-site recall gap and every
 * leading-backslash inline EDGE (PART E), every dynamic silence (PART F), the six trap cases
 * T1–T6, and enums as class-like symbols (E13). Each case asserts the SPEC-CORRECT, zero-FP
 * outcome (an edge to the right node, or silence).
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — `use` import forms that resolve (FQN edge; alias is local, never the target)', () => {
  it('php-plain-use-fqn-edge', () => runCase('php-plain-use-fqn-edge'));
  it('php-aliased-use-fqn-edge', () => runCase('php-aliased-use-fqn-edge'));
  it('php-leading-backslash-use-edge', () => runCase('php-leading-backslash-use-edge'));
  it('php-grouped-use-one-edge-each', () => runCase('php-grouped-use-one-edge-each'));
  it('php-grouped-aliased-clause-edge', () => runCase('php-grouped-aliased-clause-edge'));
  it('php-nested-group-base-edge', () => runCase('php-nested-group-base-edge'));
  it('php-namespace-alias-use-edge', () => runCase('php-namespace-alias-use-edge'));
  it('php-multi-clause-use-edge', () => runCase('php-multi-clause-use-edge'));
  it('php-import-sibling-same-name-trap', () => runCase('php-import-sibling-same-name-trap'));
  it('php-enum-import-edge', () => runCase('php-enum-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — function / const imports (no class edge; sibling class clause still emits)', () => {
  it('php-use-function-no-edge', () => runCase('php-use-function-no-edge'));
  it('php-use-const-no-edge', () => runCase('php-use-const-no-edge'));
  it('php-grouped-use-function-no-edge', () => runCase('php-grouped-use-function-no-edge'));
  it('php-grouped-mixed-function-class-edge', () => runCase('php-grouped-mixed-function-class-edge'));
  it('php-grouped-mixed-const-class-edge', () => runCase('php-grouped-mixed-const-class-edge'));
  it('php-grouped-mixed-position-independent-edge', () =>
    runCase('php-grouped-mixed-position-independent-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Namespace-RELATIVE inline forms (no leading `\`). Resolved against the file's namespace +
// `use` aliases, which a source-only tool cannot reconstruct (no-global-fallback / sibling
// same-name traps), so they STAY a tolerated recall gap (silence). The absolute counterparts
// edge (see the leading-backslash block below).
describe('MATRIX — namespace-relative inline forms (FP-prone → SILENT, not a bug)', () => {
  it('php-new-relative-silence', () => runCase('php-new-relative-silence'));
  it('php-extends-implements-relative-silence', () =>
    runCase('php-extends-implements-relative-silence'));
  it('php-trait-use-relative-silence', () => runCase('php-trait-use-relative-silence'));
  it('php-param-return-property-relative-silence', () =>
    runCase('php-param-return-property-relative-silence'));
  it('php-instanceof-relative-silence', () => runCase('php-instanceof-relative-silence'));
  it('php-class-const-relative-silence', () => runCase('php-class-const-relative-silence'));
  it('php-static-call-relative-silence', () => runCase('php-static-call-relative-silence'));
  it('php-catch-relative-silence', () => runCase('php-catch-relative-silence'));
  it('php-attribute-relative-silence', () => runCase('php-attribute-relative-silence'));
  it('php-namespace-relative-keyword-silence', () =>
    runCase('php-namespace-relative-keyword-silence'));
  it('php-enum-case-relative-silence', () => runCase('php-enum-case-relative-silence'));
  it('php-qualified-usage-via-alias-edge', () => runCase('php-qualified-usage-via-alias-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// LEADING-BACKSLASH inline references are ABSOLUTE (resolved from the global namespace,
// independent of the file's `namespace`/`use` aliases) → shadow-free → a real, zero-FP edge in
// every CLASS-autoload position (new / extends / implements / in-class trait use / `::` static /
// `::class` / type hint / instanceof / `#[\Attr]`). FUNCTION-call and bare-CONSTANT positions are
// excluded (PHP does not autoload those) → SILENT.
describe('MATRIX — leading-backslash inline (absolute, shadow-free) → EDGE', () => {
  it('php-inline-backslash-new-edge', () => runCase('php-inline-backslash-new-edge'));
  it('php-inline-backslash-extends-implements-edge', () =>
    runCase('php-inline-backslash-extends-implements-edge'));
  it('php-inline-backslash-trait-use-edge', () => runCase('php-inline-backslash-trait-use-edge'));
  it('php-inline-backslash-param-return-property-edge', () =>
    runCase('php-inline-backslash-param-return-property-edge'));
  it('php-inline-backslash-instanceof-edge', () => runCase('php-inline-backslash-instanceof-edge'));
  it('php-inline-backslash-class-const-edge', () => runCase('php-inline-backslash-class-const-edge'));
  it('php-inline-backslash-static-call-edge', () => runCase('php-inline-backslash-static-call-edge'));
  it('php-inline-backslash-multi-catch-edge', () => runCase('php-inline-backslash-multi-catch-edge'));
  it('php-inline-backslash-attribute-edge', () => runCase('php-inline-backslash-attribute-edge'));
  it('php-inline-backslash-function-call-silence', () =>
    runCase('php-inline-backslash-function-call-silence'));
  it('php-inline-backslash-bare-constant-silence', () =>
    runCase('php-inline-backslash-bare-constant-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — the trap cases T1–T6 (prove no mis-binding: SILENCE or import-bound target)', () => {
  it('php-no-global-fallback-silence', () => runCase('php-no-global-fallback-silence'));
  it('php-arrayobject-trap-silence', () => runCase('php-arrayobject-trap-silence'));
  it('php-trap-alias-matching-current-ns-edge', () =>
    runCase('php-trap-alias-matching-current-ns-edge'));
  it('php-trap-qualified-first-segment-clash-edge', () =>
    runCase('php-trap-qualified-first-segment-clash-edge'));
  it('php-trap-trait-use-relative-import-edge', () =>
    runCase('php-trap-trait-use-relative-import-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic forms (false-positive sources: MUST be SILENT)', () => {
  it('php-dynamic-new-var-silence', () => runCase('php-dynamic-new-var-silence'));
  it('php-dynamic-var-static-call-silence', () => runCase('php-dynamic-var-static-call-silence'));
  it('php-dynamic-new-expr-silence', () => runCase('php-dynamic-new-expr-silence'));
  it('php-dynamic-obj-class-silence', () => runCase('php-dynamic-obj-class-silence'));
  it('php-dynamic-class-alias-silence', () => runCase('php-dynamic-class-alias-silence'));
  it('php-dynamic-namespace-concat-silence', () => runCase('php-dynamic-namespace-concat-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — PSR-4 resolution (longest prefix; unique-root → resolved; multi-root → SILENCE)', () => {
  it('php-psr4-single-root-edge', () => runCase('php-psr4-single-root-edge'));
  it('php-psr4-longest-prefix-wins-edge', () => runCase('php-psr4-longest-prefix-wins-edge'));
  it('php-psr4-vendor-no-prefix-silence', () => runCase('php-psr4-vendor-no-prefix-silence'));
  it('php-psr4-two-roots-one-hit-edge', () => runCase('php-psr4-two-roots-one-hit-edge'));
  it('php-psr4-two-roots-both-hit-ambiguous-silence', () =>
    runCase('php-psr4-two-roots-both-hit-ambiguous-silence'));
  it('php-psr4-extra-prefix-single-hit-edge', () => runCase('php-psr4-extra-prefix-single-hit-edge'));
});
