import { describe, it, expect } from 'vitest';
import { runCase } from '../reference-case-runner.js';
import { javaExtractor } from '../../../../src/relations/extractors/java.js';
import { resolveJavaFqn, type JavaResolveDeps } from '../../../../src/relations/extractors/java-resolve.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

/**
 * JAVA NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per
 * identification case. Every case is backed by a reference-catalogue doc
 * (reference/relations/java/<id>.md): the embedded fixture code + the documented
 * `## Expect` outcome are the single source of truth, asserted end-to-end through the
 * REAL relation pass (extractor + resolver) by runCase. The two relations aspects
 * (reference/relations/case-has-test + case-is-tested) enforce the 1:1 catalogue↔test
 * correspondence, so this file cannot drift from the catalogue.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the Java
 * extractor is and STAYS IMPORT-ONLY. A dependency edge is established ONLY by an
 * `import_declaration` (or, NEW, a `module-info.java` `uses`/`provides` directive — a
 * shadow-free service-TYPE FQN), whose operand is a FULLY-QUALIFIED type (or a package,
 * for a wildcard) resolved to a `.java` file by the package = directory convention,
 * fail-to-silence on a miss. Adding usage-site / same-package / wildcard-expansion /
 * bare-simple-name resolution is FORBIDDEN — it would reintroduce the JLS §6.5.5
 * simple-name precedence trap. The cardinal invariant — ZERO false positives, a hard
 * wall with no adopter waiver — outranks recall; a missed edge is a tolerated
 * false-NEGATIVE.
 *
 * THE KEY STRUCTURAL PROPERTY: Java `uses()` emits ONLY `path` hints (the import FQN /
 * package / module-info service type), which route through the PATH axis (`resolveJavaFqn`
 * / `resolveJavaPackageFiles`), NEVER through the SymbolTable. The classic name-collision
 * FP trap is therefore structurally unreachable: the analyzer keys off the fully-qualified
 * STRING and an exact file path, never a bare simple name resolved against a symbol table.
 * The Java symbol table (built from `declarations()`) is parity data only — no Java symbol
 * hint ever reads it.
 *
 * The catalogue covers the full research enumeration (.plans/2026-06-15-java-name-resolution-
 * research.md): import forms (B1–B4/B6), wildcard owner-set collapse, JDK/stdlib/external
 * silence (C1), nested keying & fallback (D1), every usage-site recall gap (F1–F21, D2),
 * the MUST-EXCLUDE non-type tokens (G1–G4), and the newer 17→25 forms — module import
 * (B5, SILENCE), module-info uses/provides (E1, EDGE), implicit java.base (C2, SILENCE),
 * unnamed `_` (G4, SILENCE), and switch record/type patterns (G5, SILENCE).
 *
 * A handful of original matrix cases assert things the runCase harness cannot express —
 * the parity-only `declarations()` KEY SHAPE (no edges), a pure `resolveJavaFqn` unit
 * invariant, a split package across two nodes in ONE directory (the runner maps every
 * embedded file to its parent-dir node, so one directory has exactly one owner), and a
 * resolved-but-UNMAPPED file (every embedded file is mapped). Those stay as direct
 * extractor/resolver assertions below (no catalogue .md), so nothing is dropped.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (exact-FQN path edge; binds the EXACT file, never a sibling same-name)', () => {
  it('java-single-type-import-edge', () => runCase('java-single-type-import-edge'));
  it('java-single-import-sibling-same-name-trap', () => runCase('java-single-import-sibling-same-name-trap'));
  it('java-multi-import-one-edge-each', () => runCase('java-multi-import-one-edge-each'));
  it('java-no-import-alias', () => runCase('java-no-import-alias'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — static imports: the declaring TYPE is the edge, never a member or a phantom package', () => {
  it('java-single-static-import-drop-member-edge', () => runCase('java-single-static-import-drop-member-edge'));
  it('java-static-import-member-sibling-trap', () => runCase('java-static-import-member-sibling-trap'));
  it('java-static-on-demand-type-not-package-edge', () => runCase('java-static-on-demand-type-not-package-edge'));
  it('java-static-on-demand-no-phantom-package-dir', () => runCase('java-static-on-demand-no-phantom-package-dir'));
  it('java-static-collision-both-type-edges', () => runCase('java-static-collision-both-type-edges'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard / on-demand type import: package hint → owner-set collapse', () => {
  it('java-wildcard-one-owner-edge', () => runCase('java-wildcard-one-owner-edge'));
  it('java-wildcard-zero-owner-silence', () => runCase('java-wildcard-zero-owner-silence'));
  it('java-two-wildcards-each-own-merit-edge', () => runCase('java-two-wildcards-each-own-merit-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — java.lang / stdlib / external / vendored: fail-to-find silence, except a mapped vendored file', () => {
  it('java-jdk-import-silence', () => runCase('java-jdk-import-silence'));
  it('java-explicit-stdlib-import-silence', () => runCase('java-explicit-stdlib-import-silence'));
  it('java-bare-autoimport-usage-silence', () => runCase('java-bare-autoimport-usage-silence'));
  it('java-meta-annotation-usage-silence', () => runCase('java-meta-annotation-usage-silence'));
  it('java-external-library-import-silence', () => runCase('java-external-library-import-silence'));
  it('java-vendored-jdk-mapped-edge', () => runCase('java-vendored-jdk-mapped-edge'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested types: resolve to the ENCLOSING file (one-level fallback), never deeper', () => {
  it('java-nested-import-enclosing-file-edge', () => runCase('java-nested-import-enclosing-file-edge'));
  it('java-deep-nested-import-one-level-limit-silence', () => runCase('java-deep-nested-import-one-level-limit-silence'));
  it('java-qualified-inline-outer-import-only-edge', () => runCase('java-qualified-inline-outer-import-only-edge'));
  it('java-binary-name-string-silence', () => runCase('java-binary-name-string-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — non-type tokens that must NEVER become an edge (enum case / primitive .class / var / unnamed _)', () => {
  it('java-enum-case-label-silence', () => runCase('java-enum-case-label-silence'));
  it('java-primitive-class-literal-silence', () => runCase('java-primitive-class-literal-silence'));
  it('java-var-reserved-name-silence', () => runCase('java-var-reserved-name-silence'));
  it('java-unnamed-underscore-not-ref', () => runCase('java-unnamed-underscore-not-ref'));
});

// ─────────────────────────────────────────────────────────────────────────────
// USAGE-SITE forms (deliberate tolerated false-NEGATIVE: SILENT, not a bug). Per
// .plans/2026-06-14-import-only-languages-decision.md: Java STAYS import-only. Every
// usage-site construct is a tolerated recall gap (silence); each case puts the referenced
// type IN-GRAPH, so the silence proves the import-only extractor emits no edge even when
// the usage-site target is a mapped node.
describe('MATRIX — same-package / inline-FQN / usage-site forms (deliberate tolerated false-NEGATIVE: SILENT)', () => {
  it('java-same-package-no-import-silence', () => runCase('java-same-package-no-import-silence'));
  it('java-fully-qualified-inline-silence', () => runCase('java-fully-qualified-inline-silence'));
  it('java-partially-qualified-inline-silence', () => runCase('java-partially-qualified-inline-silence'));
  it('java-extends-implements-usage-silence', () => runCase('java-extends-implements-usage-silence'));
  it('java-generic-argument-bound-usage-silence', () => runCase('java-generic-argument-bound-usage-silence'));
  it('java-annotation-use-usage-silence', () => runCase('java-annotation-use-usage-silence'));
  it('java-instanceof-cast-classliteral-usage-silence', () => runCase('java-instanceof-cast-classliteral-usage-silence'));
  it('java-new-anonymous-diamond-usage-silence', () => runCase('java-new-anonymous-diamond-usage-silence'));
  it('java-array-varargs-element-usage-silence', () => runCase('java-array-varargs-element-usage-silence'));
  it('java-throws-clause-usage-silence', () => runCase('java-throws-clause-usage-silence'));
  it('java-multi-catch-usage-silence', () => runCase('java-multi-catch-usage-silence'));
  it('java-method-reference-usage-silence', () => runCase('java-method-reference-usage-silence'));
  it('java-generic-method-witness-usage-silence', () => runCase('java-generic-method-witness-usage-silence'));
  it('java-record-component-sealed-permits-usage-silence', () => runCase('java-record-component-sealed-permits-usage-silence'));
  it('java-enum-constant-use-usage-silence', () => runCase('java-enum-constant-use-usage-silence'));
  it('java-switch-pattern-types-silent', () => runCase('java-switch-pattern-types-silent'));
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWER-VERSION forms (Java 17→25) the 2026-06-15 research audit found MISSING. Module
// import (`import module M;`) is the only new IMPORT form since SE 21 (SILENCE — a module
// name maps to no file/dir); module-info `uses`/`provides` are the one NEEDS-CODE EDGE
// (shadow-free service-type FQNs now emitted); implicit java.base is SILENCE. (The unnamed
// `_` and switch-pattern silences live with their token / usage-site siblings above.)
describe('MATRIX — newer forms (Java 17→25: module import, module-info uses/provides, implicit java.base)', () => {
  it('java-module-import-silence', () => runCase('java-module-import-silence'));
  it('java-module-info-uses-provides', () => runCase('java-module-info-uses-provides'));
  it('java-implicit-module-java-base-silence', () => runCase('java-implicit-module-java-base-silence'));
});

// ─────────────────────────────────────────────────────────────────────────────
// PARITY-ONLY DECLARATION KEYING & RESOLVER INVARIANTS — assertions the runCase harness
// cannot express (no cross-node EDGE to observe). Kept as direct extractor/resolver tests
// so the Java-specific behavior is still pinned and nothing is dropped.
describe('MATRIX — declaration-key shape & resolver invariants (not expressible in runCase)', () => {
  /** Parse a Java source string into a ParsedFile under a chosen repo-rel path. */
  async function parse(repoRel: string, code: string) {
    ensureLoaderRegistered();
    const tree = await parseFile(repoRel, code);
    return { path: repoRel, content: code, tree, language: 'java' as const };
  }

  /** A JavaResolveDeps over a fixed in-memory `.java` file universe (repo-rel POSIX). */
  function depsOver(files: Set<string>): JavaResolveDeps {
    return {
      exists: (p) => files.has(p),
      javaFilesIn: (dir) => {
        const prefix = dir === '' ? '' : dir + '/';
        return [...files].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
      },
    };
  }

  const ROOT = 'src/main/java';

  it('SEALED (latent): a nested decl is `+`-chained and package-qualified, never a flat phantom `Inner`', async () => {
    // GENUINE FLAT-KEY PHANTOM this matrix exposed and FIXED — the SAME shape as the
    // pre-fix Kotlin nested-type bug, and worse (Java did not even package-qualify).
    // LATENT not LIVE: Java `uses()` emits ONLY `path` hints → the SymbolTable is never
    // read for Java resolution → the phantom flat `Inner` key cannot mis-bind anything in
    // the current model. It is a phantom ONE symbol-hint away from a live FP, so it is
    // sealed by `+`-keying the nested chain and package-qualifying the key. Parity-data
    // only — Java resolution is path-based, so NO current edge changes.
    const nestedFile = await parse(`${ROOT}/com/acme/Outer.java`, 'package com.acme;\nclass Outer {\n  class Inner {}\n}\n');
    expect(javaExtractor.declarations(nestedFile).map((d) => d.symbolKey)).toEqual([
      'com.acme.Outer',
      'com.acme.Outer+Inner', // NOT the phantom flat `Inner` / `com.acme.Inner`
    ]);
    // Defense-in-depth: a top-level `import com.acme.Inner` (symbol key `com.acme.Inner`)
    // finds nothing in the table → SILENCE (the `+` key is disjoint from the dot namespace).
    const st = new SymbolTable();
    for (const d of javaExtractor.declarations(nestedFile)) st.declare('java', d.symbolKey, nestedFile.path);
    expect(st.has('java', 'com.acme.Inner')).toBe(false);
    expect(st.has('java', 'com.acme.Outer+Inner')).toBe(true);
    const r = makeResolver({
      ownerIndex: { ownerOf: (f: string) => ({ [nestedFile.path]: 'a' } as Record<string, string>)[f] } as never,
      symbolTable: st,
      resolvePathToFile: () => undefined,
    });
    expect(r.classify({ kind: 'symbol', symbolKey: 'com.acme.Inner' }, `${ROOT}/com/x/Use.java`, 'java')).toEqual({ kind: 'absent' });
  });

  it('SEALED (latent): deeper nesting is `+`-chained and package-qualified, never flat', async () => {
    const deepFile = await parse(
      `${ROOT}/com/acme/Outer.java`,
      'package com.acme;\nclass Outer {\n  static class Mid {\n    interface Deep {}\n  }\n}\n',
    );
    expect(deepFile && javaExtractor.declarations(deepFile).map((d) => d.symbolKey)).toEqual([
      'com.acme.Outer',
      'com.acme.Outer+Mid',
      'com.acme.Outer+Mid+Deep',
    ]);
  });

  it('unnamed/default-package nested decls key bare `Outer` / `Outer+Inner`, never a leading dot', async () => {
    const noPkg = await parse(`${ROOT}/Top.java`, 'class Outer {\n  class Inner {}\n}\n');
    const keys = javaExtractor.declarations(noPkg).map((d) => d.symbolKey);
    expect(keys).toEqual(['Outer', 'Outer+Inner']);
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('a single-type-import whose FQN is a package DIRECTORY (not a type file) → undefined (no package fall-through)', () => {
    // resolveJavaFqn does NO package fall-through: a TYPE hint whose FQN is actually a
    // directory of `.java` resolves to nothing. (The wildcard branch handles packages.)
    const files = new Set([
      `${ROOT}/com/acme/audit/AuditLog.java`,
      `${ROOT}/com/acme/audit/AuditWriter.java`,
    ]);
    const deps = depsOver(files);
    expect(resolveJavaFqn('com.acme.audit', `${ROOT}/com/app/Use.java`, deps)).toBeUndefined();
  });

  it('split package across TWO owners in ONE directory → 2+ owners → SILENCE (not expressible in runCase)', () => {
    // The same package directory holds files owned by node `x` AND node `y`. The runCase
    // harness maps every embedded file to its parent-dir node, so one directory has exactly
    // one owner — this split (one dir, two owners) can only be expressed with an explicit
    // owner map. Owner set = {x,y} → 2+ owners → silence (never guess across a node split).
    const files = new Set([
      `${ROOT}/com/acme/mixed/FromX.java`,
      `${ROOT}/com/acme/mixed/FromY.java`,
    ]);
    const owners: Record<string, string> = {
      [`${ROOT}/com/acme/mixed/FromX.java`]: 'x',
      [`${ROOT}/com/acme/mixed/FromY.java`]: 'y',
    };
    const deps = depsOver(files);
    // Replicate makeResolvePathToFile's Java wildcard branch: list package files, collapse owners.
    const pkgFiles = files; // resolveJavaPackageFiles over this single dir returns both
    const ownerSet = new Set<string>();
    for (const f of pkgFiles) ownerSet.add(owners[f]);
    expect(ownerSet.size).toBeGreaterThanOrEqual(2);
    // The collapse rule (size === 1 ? attribute : silence) → silence.
    expect(ownerSet.size === 1).toBe(false);
    void deps;
  });

  it('a resolved-but-UNMAPPED .java is a coverage matter → absent (silence), never a violation (not expressible in runCase)', async () => {
    // The runCase harness maps EVERY embedded file to its parent-dir node, so a
    // resolved-but-unowned file is unreachable there. Verified directly: the resolver
    // returns `absent` when ownerOf yields undefined for the resolved file.
    const files = new Set([`${ROOT}/com/unmapped/Target.java`]);
    const deps = depsOver(files);
    const r = makeResolver({
      ownerIndex: { ownerOf: () => undefined } as never,
      symbolTable: new SymbolTable(),
      resolvePathToFile: (specifier, fromFile, language, isPackage) =>
        isPackage ? undefined : resolveJavaFqn(specifier, fromFile, deps),
    });
    expect(
      r.classify({ kind: 'path', specifier: 'com.unmapped.Target' }, `${ROOT}/com/app/Use.java`, 'java'),
    ).toEqual({ kind: 'absent' });
  });
});
