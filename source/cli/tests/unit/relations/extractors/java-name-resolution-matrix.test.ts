import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { javaExtractor } from '../../../../src/relations/extractors/java.js';
import {
  resolveJavaFqn,
  resolveJavaPackageFiles,
  type JavaResolveDeps,
} from '../../../../src/relations/extractors/java-resolve.js';
import { SymbolTable } from '../../../../src/relations/symbol-table.js';
import { makeResolver } from '../../../../src/relations/resolver.js';
import type { ParsedFile } from '../../../../src/relations/extractors/types.js';
import { ensureLoaderRegistered } from '../../../../src/ast/loader-hook.js';
import { parseFile } from '../../../../src/ast/parser.js';

/**
 * JAVA NAME-RESOLUTION IDENTIFICATION MATRIX — characterization, one `it()` per distinct
 * Java identification form C1–C40 (per .plans/2026-06-14-java-name-resolution-research.md).
 * Each test realizes the CONCRETE Java source for that exact case and asserts the
 * SPEC-CORRECT, zero-FP outcome. For every resolving import form the same-name FP-trap
 * variant (a same-named type in ANOTHER package/node that must NOT be chosen) sits beside it.
 *
 * THE GOVERNING DECISION (.plans/2026-06-14-import-only-languages-decision.md): the Java
 * extractor is and STAYS IMPORT-ONLY. A dependency edge is established ONLY by an
 * `import_declaration`, whose operand is a FULLY-QUALIFIED type (or a package, for a
 * wildcard) resolved to a `.java` file by the package = directory convention, fail-to-silence
 * on a miss. Adding usage-site / same-package / wildcard-expansion / bare-simple-name
 * resolution is FORBIDDEN — it would reintroduce the JLS §6.5.5 simple-name precedence trap
 * (a nearer scope — type parameter, member type, same-package, single-import — outranks a
 * wildcard, so a bare `Foo` may NOT be bound to a wildcard package's same-name type). The
 * cardinal invariant — ZERO false positives, a hard wall with no adopter waiver — outranks
 * recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * THE KEY STRUCTURAL PROPERTY: Java `uses()` emits ONLY `path` hints (the import FQN /
 * package), which route through the PATH axis (`resolveJavaFqn` / `resolveJavaPackageFiles`),
 * NEVER through the SymbolTable. The classic name-collision FP trap is therefore structurally
 * unreachable: the analyzer keys off the fully-qualified import STRING and an exact file path,
 * never a bare simple name resolved against a symbol table. The Java symbol table (built from
 * `declarations()`) is parity data only — no Java symbol hint ever reads it.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine flat-key phantom this matrix exposed and FIXED (the nested-type block):
 *           `declarations()` keyed a nested `Inner` as the bare flat top-level name (and
 *           non-package-qualified), the SAME shape as the pre-fix Kotlin bug. LATENT here, not
 *           live, because Java resolves by PATH and never reads the symbol table — but it is a
 *           phantom one symbol-hint away from being a live FP, so it is sealed by `+`-keying
 *           the nested chain and package-qualifying the key (parity-data only; no current edge
 *           changes). See the SEALED test for the before/after key shape.
 */

const run = (code: string) => runExtractor(javaExtractor, 'java', '.java', code);

/** The path specifiers emitted for a file — each import's FQN (or package FQN). */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

/** The single hint of a one-hint import dep matching `specifier` (to read `isPackage`). */
const hintFor = (
  uses: Awaited<ReturnType<typeof run>>['uses'],
  specifier: string,
): Extract<(typeof uses)[number]['candidates'][number], { kind: 'path' }> | undefined =>
  uses
    .map((u) => u.candidates[0])
    .find((h): h is Extract<typeof h, { kind: 'path' }> => h.kind === 'path' && h.specifier === specifier);

/** Parse a Java source string into a ParsedFile under a chosen repo-rel path. */
async function parse(repoRel: string, code: string): Promise<ParsedFile> {
  ensureLoaderRegistered();
  const tree = await parseFile(repoRel, code);
  return { path: repoRel, content: code, tree, language: 'java' };
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

/**
 * Resolve one import dep through the PRODUCTION dispatch path exactly as `makeResolvePathToFile`
 * does for Java: a `path` hint routes to `resolveJavaFqn` (type) or — when `isPackage` — to
 * `resolveJavaPackageFiles` collapsed by owner set (one owner → that file; 0/2+ → silence).
 * Returns the bound OWNER node, or undefined (silence). `owners` maps resolved file → node.
 */
function resolveImport(
  hint: Extract<Awaited<ReturnType<typeof run>>['uses'][number]['candidates'][number], { kind: 'path' }>,
  fromFile: string,
  deps: JavaResolveDeps,
  owners: Record<string, string>,
): string | undefined {
  let file: string | undefined;
  if (hint.isPackage === true) {
    const candidateFiles = resolveJavaPackageFiles(hint.specifier, fromFile, deps);
    const ownerSet = new Set<string>();
    let firstFile: string | undefined;
    for (const f of candidateFiles) {
      const o = owners[f];
      if (o === undefined) continue;
      if (ownerSet.size === 0) firstFile = f;
      ownerSet.add(o);
    }
    file = ownerSet.size === 1 ? firstFile : undefined;
  } else {
    file = resolveJavaFqn(hint.specifier, fromFile, deps);
  }
  if (file === undefined) return undefined;
  return owners[file]; // unmapped (undefined) → D7 non-event → silence
}

/** Resolve EVERY import in a parsed consumer and return the bound owner per import (silence
 *  cases: every entry must be undefined). */
function resolveAll(
  consumer: ParsedFile,
  deps: JavaResolveDeps,
  owners: Record<string, string>,
): Array<string | undefined> {
  return javaExtractor.uses(consumer).map((u) => {
    const h = u.candidates[0];
    return h.kind === 'path' ? resolveImport(h, consumer.path, deps, owners) : undefined;
  });
}

const ROOT = 'src/main/java';

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — import forms that resolve (exact-FQN path edge; binds the EXACT file, never a sibling same-name)', () => {
  it('PASS C3: single-type-import `import a.b.C;` → resolves to com/a/b/C.java', async () => {
    const deps = depsOver(new Set([`${ROOT}/com/acme/payments/PaymentService.java`]));
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.payments.PaymentService;\nclass C {}\n');
    expect(specs(javaExtractor.uses(consumer))).toContain('com.acme.payments.PaymentService');
    const owners = { [`${ROOT}/com/acme/payments/PaymentService.java`]: 'pay' };
    expect(resolveAll(consumer, deps, owners)).toEqual(['pay']);
  });

  it('PASS C3 (sibling same-name trap): the import binds its OWN FQN file, never a same-named type in another package', async () => {
    // Node `pay` declares com.acme.payments.Gateway; node `vend` declares com.vendor.Gateway.
    // `import com.acme.payments.Gateway` is an EXACT path com/acme/payments/Gateway.java →
    // node pay, never the sibling com/vendor/Gateway.java. A different package = a different
    // file: collisions are impossible by construction (the FQN is the key, never a bare name).
    const files = new Set([
      `${ROOT}/com/acme/payments/Gateway.java`,
      `${ROOT}/com/vendor/Gateway.java`,
    ]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.payments.Gateway;\nclass C {}\n');
    const owners = {
      [`${ROOT}/com/acme/payments/Gateway.java`]: 'pay',
      [`${ROOT}/com/vendor/Gateway.java`]: 'vend',
    };
    expect(resolveAll(consumer, deps, owners)).toEqual(['pay']);
  });

  it('PASS C3: a multi-import file → one exact-FQN edge per import', async () => {
    const files = new Set([`${ROOT}/com/acme/a/Alpha.java`, `${ROOT}/com/acme/b/Beta.java`]);
    const consumer = await parse(
      `${ROOT}/com/app/Use.java`,
      'package com.app;\nimport com.acme.a.Alpha;\nimport com.acme.b.Beta;\nclass C {}\n',
    );
    const owners = { [`${ROOT}/com/acme/a/Alpha.java`]: 'a', [`${ROOT}/com/acme/b/Beta.java`]: 'b' };
    expect(resolveAll(consumer, depsOver(files), owners).sort()).toEqual(['a', 'b']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — static imports (C6/C7/C8): the declaring TYPE is the edge, never a member or a phantom package', () => {
  it('PASS C6: single-static-import `import static a.b.C.M;` → drops `.M` → resolves to com/a/b/C.java', async () => {
    const deps = depsOver(new Set([`${ROOT}/com/acme/util/Helpers.java`]));
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport static com.acme.util.Helpers.format;\nclass C {}\n');
    const s = specs(javaExtractor.uses(consumer));
    expect(s).toContain('com.acme.util.Helpers'); // member `format` dropped
    expect(s).not.toContain('com.acme.util.Helpers.format');
    const owners = { [`${ROOT}/com/acme/util/Helpers.java`]: 'util' };
    expect(resolveAll(consumer, deps, owners)).toEqual(['util']);
  });

  it('PASS C6 (member-name/sibling-file trap): the dropped member name must NOT bind a same-named sibling .java', async () => {
    // `import static com.acme.util.Helpers.format;` — if the `.format` member were NOT dropped,
    // and a sibling directory com/acme/util/Helpers/ held a format.java, the analyzer would
    // mis-bind. The drop guarantees the TYPE Helpers.java is the only candidate. Here a
    // (red-herring) com/acme/util/format.java exists in the same package; it must NOT be chosen.
    const files = new Set([
      `${ROOT}/com/acme/util/Helpers.java`,
      `${ROOT}/com/acme/util/format.java`, // a same-named-as-the-member sibling type file
    ]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport static com.acme.util.Helpers.format;\nclass C {}\n');
    const owners = {
      [`${ROOT}/com/acme/util/Helpers.java`]: 'util',
      [`${ROOT}/com/acme/util/format.java`]: 'wrong',
    };
    // The edge is the TYPE Helpers (util), never the member-named sibling `format` (wrong).
    expect(resolveAll(consumer, deps, owners)).toEqual(['util']);
  });

  it('PASS C7: static-import-on-demand `import static a.b.C.*;` → the asterisk is on a TYPE, not a package (isPackage=false)', async () => {
    // The single most subtle bit: an `asterisk` here does NOT mean "package". `isPackage = !isStatic`
    // → false, so com.acme.util.Constants routes as a TYPE → resolves to Constants.java, NEVER
    // scanned as a package directory com/acme/util/Constants/.
    const deps = depsOver(new Set([`${ROOT}/com/acme/util/Constants.java`]));
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport static com.acme.util.Constants.*;\nclass C {}\n');
    const h = hintFor(javaExtractor.uses(consumer), 'com.acme.util.Constants');
    expect(h).toBeDefined();
    expect(h?.isPackage).toBeFalsy(); // asterisk + static → TYPE, not package
    expect(specs(javaExtractor.uses(consumer)).every((x) => !x.includes('*'))).toBe(true);
    const owners = { [`${ROOT}/com/acme/util/Constants.java`]: 'consts' };
    expect(resolveAll(consumer, deps, owners)).toEqual(['consts']);
  });

  it('PASS C7 (no phantom package dir): a static-on-demand type FQN must NOT resolve a directory of .java as the type', async () => {
    // If com/acme/util/Constants happened to be a DIRECTORY (a package) holding .java files, a
    // static-on-demand TYPE hint must still resolve to nothing (no Constants.java type file) —
    // never a representative member of the directory. resolveJavaFqn does NO package fall-through.
    const files = new Set([
      `${ROOT}/com/acme/util/Constants/A.java`,
      `${ROOT}/com/acme/util/Constants/B.java`,
    ]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport static com.acme.util.Constants.*;\nclass C {}\n');
    const owners = {
      [`${ROOT}/com/acme/util/Constants/A.java`]: 'a',
      [`${ROOT}/com/acme/util/Constants/B.java`]: 'b',
    };
    expect(resolveAll(consumer, deps, owners).every((o) => o === undefined)).toBe(true);
  });

  it('PASS C8: static member collision (single-static-import + static-on-demand) → both imports are their declaring-TYPE edges', async () => {
    // `import static com.util.Maths.max; import static com.util.Limits.*;` — each import IS a
    // real syntactic dependency on its declaring type; both resolve independently to their type
    // files. (Which `max` actually binds at the call site is irrelevant — import-only.)
    const files = new Set([`${ROOT}/com/util/Maths.java`, `${ROOT}/com/util/Limits.java`]);
    const deps = depsOver(files);
    const consumer = await parse(
      `${ROOT}/com/app/Use.java`,
      'package com.app;\nimport static com.util.Maths.max;\nimport static com.util.Limits.*;\nclass C {}\n',
    );
    const owners = { [`${ROOT}/com/util/Maths.java`]: 'maths', [`${ROOT}/com/util/Limits.java`]: 'limits' };
    expect(resolveAll(consumer, deps, owners).sort()).toEqual(['limits', 'maths']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — wildcard / on-demand type import (C4/C5): package hint → owner-set collapse', () => {
  it('PASS C4: `import a.b.*;` emits the PACKAGE FQN (isPackage=true), no `*`, no individual class', async () => {
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.audit.*;\nclass C {}\n');
    const s = specs(javaExtractor.uses(consumer));
    expect(s).toContain('com.acme.audit');
    expect(s.every((x) => !x.includes('*'))).toBe(true);
    expect(hintFor(javaExtractor.uses(consumer), 'com.acme.audit')?.isPackage).toBe(true);
  });

  it('PASS C5: wildcard over ONE-owner package → attributes the edge to that single owner (deliberate import=edge)', async () => {
    // The package dir holds two files owned by the SAME node `aud`. Owner set = {aud} → exactly
    // one owner → attribute. This is the deliberate v1 import=edge semantics (the import IS a
    // real syntactic dependency on the package), not an FP.
    const files = new Set([
      `${ROOT}/com/acme/audit/AuditLog.java`,
      `${ROOT}/com/acme/audit/AuditWriter.java`,
    ]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.audit.*;\nclass C {}\n');
    const owners = {
      [`${ROOT}/com/acme/audit/AuditLog.java`]: 'aud',
      [`${ROOT}/com/acme/audit/AuditWriter.java`]: 'aud',
    };
    expect(resolveAll(consumer, deps, owners)).toEqual(['aud']);
  });

  it('PASS C4 (split-package SILENCE): a wildcard over a package split across TWO owners → 2+ owners → SILENCE', async () => {
    // The same package directory holds files owned by node `x` AND node `y`. Owner set = {x,y}
    // → 2+ owners → silence (never guess across a node split). No FP.
    const files = new Set([
      `${ROOT}/com/acme/mixed/FromX.java`,
      `${ROOT}/com/acme/mixed/FromY.java`,
    ]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.mixed.*;\nclass C {}\n');
    const owners = {
      [`${ROOT}/com/acme/mixed/FromX.java`]: 'x',
      [`${ROOT}/com/acme/mixed/FromY.java`]: 'y',
    };
    expect(resolveAll(consumer, deps, owners).every((o) => o === undefined)).toBe(true);
  });

  it('PASS C4 (zero-owner SILENCE): a wildcard over a package with NO mapped file → 0 owners → SILENCE', async () => {
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.empty.*;\nclass C {}\n');
    const deps = depsOver(new Set([`${ROOT}/com/app/Use.java`]));
    expect(resolveAll(consumer, deps, {}).every((o) => o === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — java.lang / stdlib / external (C9/C10/C11): MUST-SILENCE (no in-repo .java)', () => {
  it('PASS C9: `import java.util.List;` → no java/util/List.java in repo → SILENCE', async () => {
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport java.util.List;\nclass C {}\n');
    expect(specs(javaExtractor.uses(consumer))).toContain('java.util.List'); // emitted; silence is the resolver job
    const deps = depsOver(new Set([`${ROOT}/com/app/Use.java`]));
    expect(resolveAll(consumer, deps, {}).every((o) => o === undefined)).toBe(true);
  });

  it('PASS C9: explicit `import java.lang.String;` / `import javax.annotation.Nullable;` → SILENCE', async () => {
    const consumer = await parse(
      `${ROOT}/com/app/Use.java`,
      'package com.app;\nimport java.lang.String;\nimport javax.annotation.Nullable;\nimport jakarta.inject.Inject;\nclass C {}\n',
    );
    const deps = depsOver(new Set([`${ROOT}/com/app/Use.java`]));
    expect(resolveAll(consumer, deps, {}).every((o) => o === undefined)).toBe(true);
  });

  it('PASS C10: bare auto-imported `String`/`Object`/`Exception` usage (no import) → NO hint at all', async () => {
    const { uses } = await run(
      'package com.app;\nclass C extends Exception {\n  String s;\n  Object o;\n  void m() throws Exception { @Override int x = 0; }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS C11: `@Override @Deprecated @SuppressWarnings` (java.lang.annotation, no import) → NO hint', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  @Override @Deprecated @SuppressWarnings("x")\n  public String toString() { return ""; }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS: an external third-party `import com.google.common.collect.ImmutableList;` → no mapped file → SILENCE', async () => {
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.google.common.collect.ImmutableList;\nclass C {}\n');
    const deps = depsOver(new Set([`${ROOT}/com/app/Use.java`]));
    expect(resolveAll(consumer, deps, {}).every((o) => o === undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — no alias in Java (C12): the imported simple name is ALWAYS the FQN tail; no alias path exists', () => {
  it('PASS C12: Java has NO `import a.B as C;` — the grammar has no alias production; no `as`/alias key is ever emitted', async () => {
    // Guard against a future copy-paste from the Kotlin/C# extractor wrongly introducing alias
    // handling. The Java extractor reads ONLY the scoped_identifier/identifier FQN; there is no
    // alias token to track. A plain import emits exactly its FQN, never anything aliased.
    const { uses } = await run('package com.app;\nimport com.acme.payments.Gateway;\nclass C {}\n');
    const s = specs(uses);
    expect(s).toEqual(['com.acme.payments.Gateway']);
    expect(s.every((k) => !k.includes(' as ') && !k.includes(' AS '))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — nested types (C18/C19/C20/C21): resolve to the ENCLOSING file, never a phantom; flat-key seal', () => {
  it('PASS C18: nested import `import a.Outer.Inner;` → tries a/Outer/Inner.java then falls back to a/Outer.java', async () => {
    // Java compiles a nested type into its ENCLOSING file (Outer.java), not a subdirectory. The
    // resolver`s one-level parent fallback drops the trailing segment → com/foo/Outer.java.
    const deps = depsOver(new Set([`${ROOT}/com/foo/Outer.java`]));
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.foo.Outer.Inner;\nclass C {}\n');
    expect(specs(javaExtractor.uses(consumer))).toContain('com.foo.Outer.Inner'); // verbatim FQN emitted
    expect(resolveJavaFqn('com.foo.Outer.Inner', consumer.path, deps)).toBe(`${ROOT}/com/foo/Outer.java`);
    const owners = { [`${ROOT}/com/foo/Outer.java`]: 'foo' };
    expect(resolveAll(consumer, deps, owners)).toEqual(['foo']);
  });

  it('SEALED (latent) C18 — flat-key phantom: a nested decl was keyed BARE/FLAT (Kotlin-style bug) → now `<pkg>.Outer+Inner`', async () => {
    // GENUINE FLAT-KEY PHANTOM this matrix exposed and FIXED — the SAME shape as the pre-fix
    // Kotlin nested-type bug, and worse (Java did not even package-qualify).
    //
    // BEFORE: declarations() emitted `nameNode.text` — the BARE simple name — for EVERY type,
    // nested or not, with NO package qualification. `package com.acme; class Outer { class Inner }`
    // produced the phantom flat keys `Outer` and `Inner`.
    //
    // WHY LATENT, NOT LIVE TODAY: Java `uses()` emits ONLY `path` hints (the import FQN /
    // package), which route through `resolveJavaFqn`/`resolveJavaPackageFiles` — the PATH axis.
    // No Java symbol hint is ever produced, so the SymbolTable (keyed per-language) is never read
    // for Java resolution → the phantom flat `Inner` key cannot mis-bind anything in the current
    // model. It is a phantom ONE symbol-hint away from being a live false positive: the instant a
    // Java symbol consumer existed, a top-level `import com.acme.Inner` (which in Java names a
    // TOP-LEVEL type, never the nested `Outer.Inner` — that import is `com.acme.Outer.Inner`)
    // would mis-bind to this nesting file — the FP the cardinal invariant forbids.
    //
    // AFTER: a nested declaration is keyed by its enclosing-TYPE chain joined with `+` and
    // package-qualified (`com.acme.Outer+Inner`), in a string space disjoint from the dot-only
    // namespace. The phantom flat `Inner` / `com.acme.Inner` is gone. Parity-data only — Java
    // resolution is path-based, so NO current edge changes; the latent landmine is removed.
    const nestedFile = await parse(`${ROOT}/com/acme/Outer.java`, 'package com.acme;\nclass Outer {\n  class Inner {}\n}\n');
    expect(javaExtractor.declarations(nestedFile).map((d) => d.symbolKey)).toEqual([
      'com.acme.Outer',
      'com.acme.Outer+Inner', // NOT the phantom flat `Inner` / `com.acme.Inner`
    ]);
    // Defense-in-depth: even were a Java symbol hint to exist, a top-level `import com.acme.Inner`
    // (symbol key `com.acme.Inner`) finds nothing in the table → SILENCE (the `+` key is disjoint).
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

  it('SEALED (latent) C18 — deeper nesting is `+`-chained and package-qualified, never flat', async () => {
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

  it('PASS: unnamed/default-package nested decls key bare `Outer` / `Outer+Inner`, never a leading dot', async () => {
    // C39 adjacency: a compilation unit with NO `package` declaration. The keys are bare type
    // keys with no package prefix, and a nested type is still `+`-chained (never flat, never
    // a leading `.`).
    const noPkg = await parse(`${ROOT}/Top.java`, 'class Outer {\n  class Inner {}\n}\n');
    const keys = javaExtractor.declarations(noPkg).map((d) => d.symbolKey);
    expect(keys).toEqual(['Outer', 'Outer+Inner']);
    expect(keys.every((k) => !k.startsWith('.'))).toBe(true);
  });

  it('GAP (deliberate recall) C19: doubly-nested import `import a.Outer.Mid.Deep;` → one-level fallback only → SILENCE', async () => {
    // The resolver drops EXACTLY one trailing segment: com.acme.Outer.Mid.Deep → tries
    // com/acme/Outer/Mid/Deep.java (no) then com/acme/Outer/Mid.java (no — Mid is also nested in
    // Outer.java, not its own file). It does NOT drop further to com/acme/Outer.java. Result:
    // a tolerated false-NEGATIVE (silence), never an FP. Documented one-level limit.
    const deps = depsOver(new Set([`${ROOT}/com/acme/Outer.java`]));
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.acme.Outer.Mid.Deep;\nclass C {}\n');
    expect(resolveJavaFqn('com.acme.Outer.Mid.Deep', consumer.path, deps)).toBeUndefined();
    const owners = { [`${ROOT}/com/acme/Outer.java`]: 'foo' };
    expect(resolveAll(consumer, deps, owners).every((o) => o === undefined)).toBe(true);
  });

  it('GAP (deliberate recall) C20: qualified inline `Outer.Inner i;` with `import a.Outer;` → only the OUTER import is the edge', async () => {
    // The import line `com.foo.Outer` resolves to Outer.java (the edge to Outer`s node IS
    // captured). The `.Inner` qualifier at the use site adds no separate hint (import-only), and
    // since Inner lives in the same file as Outer, the same node owns it — nothing additional to
    // miss. Benign. Here we assert the ONLY emitted hint is the outer import.
    const consumer = await parse(
      `${ROOT}/com/app/Use.java`,
      'package com.app;\nimport com.foo.Outer;\nclass C {\n  Outer.Inner i;\n  Outer.Mid.Deep d;\n}\n',
    );
    expect(specs(javaExtractor.uses(consumer))).toEqual(['com.foo.Outer']);
  });

  it('GAP (deliberate recall) C21: binary name `a.Outer$Inner` inside Class.forName(...) → string literal, NO hint', async () => {
    // The `$` reflection/binary form appears ONLY in string literals; tree-sitter sees a
    // string_literal, and the extractor walks only import_declaration → no hint, no FP.
    const { uses } = await run(
      'package com.app;\nclass C {\n  void m() throws Exception { Class<?> k = Class.forName("com.acme.Outer$Inner"); }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — ambiguity (C17): two wildcards offering the same simple name → never an arbitrary edge', () => {
  it('PASS C17: `import a.*; import b.*;` both could offer `Foo` → each package hint resolves on its OWN merit (no use-site guess)', async () => {
    // In Java this is a COMPILE ERROR for the bare `Foo` use, but the analyzer never binds the
    // bare simple name — it emits two independent PACKAGE hints (com.x, com.y), each owner-set
    // collapsed on its own. No fabricated use-site edge for the ambiguous `Foo`. Here each
    // package maps to exactly one owner, so each wildcard attributes ITS package edge (import =
    // edge), and the ambiguous `Foo` use is silent (never emitted).
    const files = new Set([`${ROOT}/com/x/Foo.java`, `${ROOT}/com/y/Foo.java`]);
    const deps = depsOver(files);
    const consumer = await parse(
      `${ROOT}/com/app/Use.java`,
      'package com.app;\nimport com.x.*;\nimport com.y.*;\nclass C { Foo f; }\n',
    );
    // Exactly two package hints; the bare `Foo` use produces NO hint.
    expect(specs(javaExtractor.uses(consumer)).sort()).toEqual(['com.x', 'com.y']);
    const owners = { [`${ROOT}/com/x/Foo.java`]: 'x', [`${ROOT}/com/y/Foo.java`]: 'y' };
    expect(resolveAll(consumer, deps, owners).sort()).toEqual(['x', 'y']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — non-type tokens that must NEVER become an edge (C28/C37/C38): enum case / primitive .class / var', () => {
  it('PASS C37: enum `case RED:` labels are unqualified constants of the switch selector — NO hint', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  enum Color { RED, GREEN }\n  int m(Color c) {\n    switch (c) { case RED: return 1; case GREEN: return 2; default: return 0; }\n  }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS C28: primitive `int.class` / `void.class` / `boolean.class` → no .java file → NO hint', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  Object a = int.class;\n  Object b = void.class;\n  Object d = boolean.class;\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('PASS C38: `var x = ...;` — `var` is a reserved type name, not a type → NO hint (and no phantom `var` edge)', async () => {
    const { uses } = await run('package com.app;\nclass C {\n  void m() { var x = 1; var s = "a"; }\n}\n');
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — same-package / inline-FQN / partial (C1/C2/C22/C23): import-only recall gaps (tolerated false-NEGATIVE)', () => {
  it('GAP (deliberate recall) C1/C2: same-package reference with NO import (`class Child extends Parent`) — SILENT', async () => {
    // Same-package types are visible by simple name with no import (JLS §7.6). Import-only emits
    // nothing. C1 (same node) is benign (intra-node, not a relation). C2 (a cross-node split
    // package) is a REAL tolerated false-NEGATIVE — adding bare-simple-name resolution to catch
    // it would reintroduce the §6.5.5 precedence trap and is FORBIDDEN by the decision doc.
    const { uses } = await run('package com.a;\nclass Child extends Parent {\n  Sibling s;\n}\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C22: fully-qualified INLINE `a.b.C x = new a.b.C();` with NO import — SILENT (biggest gap)', async () => {
    // The single biggest coverage gap of the import-only model: a genuine cross-node dependency
    // expressed entirely WITHOUT an import. C22 is also the SAFEST future usage-site extension —
    // a fully-qualified name is shadow-free (JLS §6.5.5.2), so it dodges the §6.5.5 precedence
    // trap entirely — but it is NEW extractor code and is deferred to OWNER review, NOT
    // auto-implemented. Current behavior: silence.
    const { uses } = await run(
      'package com.a;\nclass X {\n  com.b.Bar field;\n  java.util.List<String> list = new java.util.ArrayList<>();\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C23: partially-qualified inline `Outer.Inner` (Outer same-package, no import) — SILENT', async () => {
    const { uses } = await run('package com.a;\nclass X {\n  Outer.Inner i;\n}\n');
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — all other usage-site forms (C24/C25/C26/C27/C29..C36): deliberate tolerated false-NEGATIVE, SILENT', () => {
  // Per the decision doc: Java STAYS import-only. Every usage-site construct below references a
  // type WITHOUT contributing a hint on its own (only its import line, if any, does). Binding any
  // by simple name would reintroduce the §6.5.5 precedence + ambiguity traps and is FORBIDDEN.

  it('GAP (deliberate recall) C24: `extends` / `implements` with FQ names — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C extends com.acme.base.Base implements com.acme.flow.Flowable, Runnable {}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C25: generic argument / bound / intersection / wildcard bound — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C<T extends com.acme.model.Base & com.acme.flow.Iface> {\n  java.util.List<com.acme.model.Foo> a;\n  java.util.List<? extends com.acme.model.Bar> b;\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C26: user-package annotation use `@a.Audit` — SILENT', async () => {
    const { uses } = await run('package com.app;\n@com.acme.audit.Audit\nclass C {}\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C27: `instanceof` / cast / reference-type `.class` — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  void m(Object o) {\n    if (o instanceof com.acme.model.Foo f) {}\n    var x = (com.acme.model.Bar) o;\n    var k = com.acme.model.Baz.class;\n  }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C29: `new` / anonymous class / diamond — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  void m() {\n    var a = new com.acme.metrics.Timer();\n    var b = new com.acme.base.Base() {};\n    var c = new java.util.HashMap<String, com.acme.model.Foo>();\n  }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C30: array `Foo[]` / varargs `Foo...` element types — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  com.acme.model.Foo[] a;\n  void m(com.acme.model.Bar... xs) {}\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C31: `throws` clause type — SILENT', async () => {
    const { uses } = await run('package com.app;\nclass C {\n  void m() throws com.acme.err.Boom {}\n}\n');
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C32: multi-catch `catch (A | B e)` — two refs, both SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  void m() { try {} catch (com.acme.err.E1 | com.acme.err.E2 e) {} }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C33: method reference `Type::m` / `Type::new` — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nimport java.util.function.Supplier;\nclass C {\n  Runnable r = com.acme.util.Helpers::format;\n  Supplier<com.acme.model.Foo> s = com.acme.model.Foo::new;\n}\n',
    );
    // Only the JDK `Supplier` import is emitted (and it resolves to nothing); the `::` refs are silent.
    expect(specs(uses)).toEqual(['java.util.function.Supplier']);
  });

  it('GAP (deliberate recall) C34: generic method type witness `Collections.<Foo>emptyList()` — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  void m() { var l = java.util.Collections.<com.acme.model.Foo>emptyList(); }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C35: `record R(a.Foo f)` component / `sealed ... permits a.Sub` — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nrecord R(com.acme.model.Foo f) {}\nsealed interface S permits com.acme.model.Sub {}\n',
    );
    expect(uses).toHaveLength(0);
  });

  it('GAP (deliberate recall) C36: enum constant USE `Color.RED` (qualified, no import on Color) — SILENT', async () => {
    const { uses } = await run(
      'package com.app;\nclass C {\n  Object m() { return com.acme.model.Color.RED; }\n}\n',
    );
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — vendored-JDK-in-repo (C40): a real, in-repo, MAPPED .java is correctly attributed, NOT an FP', () => {
  it('PASS C40: a repo that VENDORS java/lang/String.java AND maps it → `import java.lang.String;` correctly attributes the edge', async () => {
    // The ONLY way a java.* import fires: the adopter literally vendored java/lang/String.java
    // into the repo at a path the package=directory convention finds, AND mapped it to a node.
    // At that point it is a real, in-repo, mapped dependency — flagging the missing relation is
    // CORRECT, not a false positive. (Anti-FP property: silence is fail-to-find, not a java.*
    // denylist — a present-and-mapped file is a genuine edge.)
    const files = new Set([`${ROOT}/java/lang/String.java`]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport java.lang.String;\nclass C {}\n');
    expect(resolveJavaFqn('java.lang.String', consumer.path, deps)).toBe(`${ROOT}/java/lang/String.java`);
    const owners = { [`${ROOT}/java/lang/String.java`]: 'vendored-jdk' };
    expect(resolveAll(consumer, deps, owners)).toEqual(['vendored-jdk']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — resolution-miss invariants (the fail-to-silence anti-FP guards)', () => {
  it('PASS: a single-type-import whose path is a package DIRECTORY (not a type file) → SILENCE, never a phantom package edge', async () => {
    // resolveJavaFqn does NO package fall-through: a TYPE hint whose FQN is actually a directory
    // of .java resolves to nothing. (The wildcard branch handles packages; a plain import must not.)
    const files = new Set([
      `${ROOT}/com/acme/audit/AuditLog.java`,
      `${ROOT}/com/acme/audit/AuditWriter.java`,
    ]);
    const deps = depsOver(files);
    expect(resolveJavaFqn('com.acme.audit', `${ROOT}/com/app/Use.java`, deps)).toBeUndefined();
  });

  it('PASS: a resolved-but-UNMAPPED .java (D7) is a coverage matter → SILENCE, never a violation', async () => {
    const files = new Set([`${ROOT}/com/unmapped/Target.java`]);
    const deps = depsOver(files);
    const consumer = await parse(`${ROOT}/com/app/Use.java`, 'package com.app;\nimport com.unmapped.Target;\nclass C {}\n');
    // The FQN resolves to a real file, but no node owns it → undefined owner → silence.
    expect(resolveAll(consumer, deps, {} /* no owner */).every((o) => o === undefined)).toBe(true);
  });
});
