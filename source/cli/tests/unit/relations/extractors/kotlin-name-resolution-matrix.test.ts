import { describe, it, expect } from 'vitest';
import { runCase } from '../reference-case-runner.js';
import { kotlinExtractor } from '../../../../src/relations/extractors/kotlin.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

/**
 * KOTLIN NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/kotlin/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so this file cannot drift from the catalogue.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the Kotlin
 * extractor is and STAYS IMPORT-ONLY. A dependency edge is established ONLY by an `import`,
 * whose operand is a fully-qualified symbol resolved through the shared SymbolTable. Adding
 * usage-site / same-package / wildcard-expansion / bare-simple-name resolution is FORBIDDEN —
 * it would reintroduce the precedence trap (explicit-import > same-package > star > stdlib) and
 * the stdlib-collision trap (a project `Result`/`Pair`/`List` colliding with an invisible
 * stdlib name). The cardinal invariant — ZERO false positives, a hard wall with no adopter
 * waiver — outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The catalogue covers the full research enumeration (.plans/2026-06-15-kotlin-name-resolution-
 * research.md): import forms (A1/A3/A4/A5/A6/A7/A8/A9), implicit stdlib (B1), nested/JVM
 * keying (C1/C2), every usage-site recall gap (D1–D18), and the newer 2.0→2.4 forms
 * (E5 context parameters, E6 context-sensitive resolution, E7 nested type aliases, E8
 * use-site-target keywords). Each case asserts the SPEC-CORRECT, zero-FP outcome (an edge to
 * the right node, or silence); for every resolving form the same-name FP-trap variant sits in
 * the case's `## Files` + `## Expect`.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (FQN edge; binds the EXACT FQN, never a sibling same-name)', () => {
  it('kotlin-plain-import-fqn-edge', () => runCase('kotlin-plain-import-fqn-edge'));
  it('kotlin-plain-import-sibling-same-name-trap', () => runCase('kotlin-plain-import-sibling-same-name-trap'));
  it('kotlin-multi-import-one-edge-each', () => runCase('kotlin-multi-import-one-edge-each'));
  it('kotlin-package-header-keying-edge', () => runCase('kotlin-package-header-keying-edge'));
  it('kotlin-root-package-bare-keys-edge', () => runCase('kotlin-root-package-bare-keys-edge'));
  it('kotlin-top-level-fun-import-exact-fqn', () => runCase('kotlin-top-level-fun-import-exact-fqn'));
  it('kotlin-top-level-fun-sibling-same-name-trap', () => runCase('kotlin-top-level-fun-sibling-same-name-trap'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — alias import (`import a.b.C as D`): target is the FQN before `as`; `D` is never a key)', () => {
  it('kotlin-alias-import-fqn-before-as', () => runCase('kotlin-alias-import-fqn-before-as'));
  it('kotlin-alias-import-name-not-a-target', () => runCase('kotlin-alias-import-name-not-a-target'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — enum / companion / object member imports (resolve at the declared-TYPE boundary, else SILENCE)', () => {
  it('kotlin-enum-member-import-verbatim-silence', () => runCase('kotlin-enum-member-import-verbatim-silence'));
  it('kotlin-enum-entry-import-not-indexed-silence', () => runCase('kotlin-enum-entry-import-not-indexed-silence'));
  it('kotlin-member-chain-not-subpackage-silence', () => runCase('kotlin-member-chain-not-subpackage-silence'));
  it('kotlin-companion-member-import-plus-split', () => runCase('kotlin-companion-member-import-plus-split'));
  it('kotlin-object-member-import-plus-split', () => runCase('kotlin-object-member-import-plus-split'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard import (`import a.b.*`): emits the PACKAGE hint → SILENCE (expansion FORBIDDEN)', () => {
  it('kotlin-wildcard-import-package-hint-silence', () => runCase('kotlin-wildcard-import-package-hint-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — default / implicit stdlib (Form 3): unimported names → SILENCE (the collision trap)', () => {
  it('kotlin-implicit-stdlib-no-import-silence', () => runCase('kotlin-implicit-stdlib-no-import-silence'));
  it('kotlin-stdlib-collision-project-result-silence', () => runCase('kotlin-stdlib-collision-project-result-silence'));
  it('kotlin-explicit-stdlib-import-absent-silence', () => runCase('kotlin-explicit-stdlib-import-absent-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested / inner types (Form 4): split at a declared-TYPE boundary, NEVER deeper packages', () => {
  it('kotlin-nested-flat-key-fp-sealed', () => runCase('kotlin-nested-flat-key-fp-sealed'));
  it('kotlin-nested-import-plus-split-edge', () => runCase('kotlin-nested-import-plus-split-edge'));
  it('kotlin-deep-nested-import-plus-split-edge', () => runCase('kotlin-deep-nested-import-plus-split-edge'));
  it('kotlin-nested-vs-subpackage-ambiguous-silence', () => runCase('kotlin-nested-vs-subpackage-ambiguous-silence'));
  it('kotlin-nested-plus-key-not-dollar-edge', () => runCase('kotlin-nested-plus-key-not-dollar-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
// USAGE-SITE forms (deliberate tolerated false-NEGATIVE: SILENT, not a bug). Per
// .plans/2026-06-14-import-only-languages-decision.md: Kotlin STAYS import-only. Every
// usage-site construct is a tolerated recall gap (silence). Each case puts the referenced
// type IN-GRAPH, so the silence proves the import-only extractor emits no edge even when the
// usage-site target is a mapped node — binding any of them by simple name would reintroduce
// the precedence + stdlib-collision FP traps and is FORBIDDEN.
describe('MATRIX — usage-site forms (deliberate tolerated false-NEGATIVE: SILENT, not a bug)', () => {
  it('kotlin-supertype-list-usage-silence', () => runCase('kotlin-supertype-list-usage-silence'));
  it('kotlin-generic-argument-where-usage-silence', () => runCase('kotlin-generic-argument-where-usage-silence'));
  it('kotlin-is-as-test-cast-usage-silence', () => runCase('kotlin-is-as-test-cast-usage-silence'));
  it('kotlin-param-return-property-usage-silence', () => runCase('kotlin-param-return-property-usage-silence'));
  it('kotlin-annotation-use-usage-silence', () => runCase('kotlin-annotation-use-usage-silence'));
  it('kotlin-class-literal-callable-ref-usage-silence', () => runCase('kotlin-class-literal-callable-ref-usage-silence'));
  it('kotlin-constructor-call-usage-silence', () => runCase('kotlin-constructor-call-usage-silence'));
  it('kotlin-typealias-rhs-usage-silence', () => runCase('kotlin-typealias-rhs-usage-silence'));
  it('kotlin-extension-receiver-usage-silence', () => runCase('kotlin-extension-receiver-usage-silence'));
  it('kotlin-delegation-by-usage-silence', () => runCase('kotlin-delegation-by-usage-silence'));
  it('kotlin-when-subject-smartcast-usage-silence', () => runCase('kotlin-when-subject-smartcast-usage-silence'));
  it('kotlin-pair-to-tuple-usage-silence', () => runCase('kotlin-pair-to-tuple-usage-silence'));
  it('kotlin-nullable-array-vararg-usage-silence', () => runCase('kotlin-nullable-array-vararg-usage-silence'));
  it('kotlin-bare-top-level-call-only-import-edge', () => runCase('kotlin-bare-top-level-call-only-import-edge'));
  it('kotlin-fully-qualified-inline-ref-usage-silence', () => runCase('kotlin-fully-qualified-inline-ref-usage-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — JVM artifacts (Form 8): no `<File>Kt` facade / `@file:JvmName` key for Kotlin resolution', () => {
  it('kotlin-jvmname-no-facade-key-edge', () => runCase('kotlin-jvmname-no-facade-key-edge'));
  it('kotlin-multiple-top-level-decls-one-key-each', () => runCase('kotlin-multiple-top-level-decls-one-key-each'));
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWER-VERSION forms (Kotlin 2.0→2.4) the 2026-06-15 research audit found MISSING.
// Three are usage-site/no-new-edge SILENCEs whose value is documenting the boundary so a
// future usage-site implementer does not mishandle them; one (nested type alias) is a new
// declaration-keying EDGE the existing enclosing-type-chain logic already handles (pinned here).
describe('MATRIX — newer forms (Kotlin 2.0→2.4: context params, context-sensitive resolution, nested type alias, use-site target)', () => {
  it('kotlin-context-parameter-type-silent', () => runCase('kotlin-context-parameter-type-silent'));
  it('kotlin-context-sensitive-resolution-no-edge', () => runCase('kotlin-context-sensitive-resolution-no-edge'));
  it('kotlin-nested-type-alias-plus-keyed', () => runCase('kotlin-nested-type-alias-plus-keyed'));
  it('kotlin-annotation-use-site-target-not-ref', () => runCase('kotlin-annotation-use-site-target-not-ref'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — ambiguity collapses to SILENCE (never an arbitrary edge)', () => {
  it('kotlin-same-fqn-two-files-ambiguous-silence', () => runCase('kotlin-same-fqn-two-files-ambiguous-silence'));

  // Resolver-level case that the runCase harness cannot express: the harness maps EVERY
  // embedded file to its parent-directory node, so a declared-but-UNMAPPED in-graph file
  // (ownerOf → undefined → `absent`) is unreachable here. The form — "a resolved FQN whose
  // file has no owning node is a coverage matter, never a relation violation → absent →
  // silence" — is verified generically at the resolver level (resolver.test.ts: "a UNIQUE but
  // UNMAPPED definition is `absent`"). Kept as a direct extractor+resolver assertion (no
  // catalogue .md) so the Kotlin-specific path is still pinned and nothing is dropped.
  it('UNMAPPED in-graph file → absent (coverage matter, never a violation; not expressible in runCase)', async () => {
    ensureLoaderRegistered();
    const tree = await parseFile('src/a/Order.kt', 'package com.acme\nclass Order\n');
    const declFile = { path: 'src/a/Order.kt', content: 'package com.acme\nclass Order\n', tree, language: 'kotlin' as const };
    const st = new SymbolTable();
    for (const d of kotlinExtractor.declarations(declFile)) st.declare('kotlin', d.symbolKey, declFile.path);
    // ownerOf returns undefined → the mapped file has no owning node → absent (silence).
    const r = makeResolver({
      ownerIndex: { ownerOf: () => undefined } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.Order' }, 'src/c/Use.kt', 'kotlin')).toEqual({ kind: 'absent' });
  });
});
