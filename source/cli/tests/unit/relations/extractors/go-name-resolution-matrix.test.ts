import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { goExtractor } from '../../../../src/relations/extractors/go.js';
import { resolveGoImport, type GoResolveDeps } from '../../../../src/relations/extractors/go-resolve.js';

/**
 * GO IMPORT-PATH IDENTIFICATION MATRIX — characterization, one `it()` per distinct Go import
 * identification form. Each test realizes the CONCRETE source for that exact case (and, for the
 * resolution rows, a CONCRETE module path + package-directory layout) and asserts the
 * SPEC-CORRECT, zero-FP outcome. Two layers are exercised: the EXTRACTOR (which import-path
 * SPECIFIER an import declaration emits) and the RESOLVER (which repo-relative `.go` FILE a
 * specifier maps to, after stripping the go.mod module prefix to a package directory). For every
 * resolving PATH form the same-LEAF FP-trap variant (a directory with the SAME final segment
 * elsewhere that must NOT be chosen) sits beside the positive.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Go resolves an import to a PACKAGE DIRECTORY by import PATH — the go.mod `module` path is the
 * prefix, and the remaining path segments name the directory under the module root. It does NOT
 * resolve by namespace-relative simple-NAME binding, so the §-precedence simple-name trap that
 * drives the symbol languages does not apply. The FP risks are path/module-resolution-specific
 * and Go-shaped:
 *   - a LEAF-name match instead of a full-path match (a directory whose last segment collides
 *     with the import's last segment but sits elsewhere),
 *   - an external / stdlib import (no module-prefix match) mis-rooted to an in-repo directory,
 *   - a textual module-prefix overlap that is NOT a path boundary (`<module>x/...` vs `<module>/`),
 *   - a SPLIT package (one directory whose `.go` files are mapped to 2+ nodes) attributed to one
 *     file's owner (the F20 case),
 *   - the package CLAUSE inside the files misleading resolution when it differs from the dir name.
 * The cardinal invariant — ZERO false positives, a hard wall with no adopter waiver — outranks
 * recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here:
 *   GO1  Only an `import_spec` is an edge (single `import "x"`, grouped `import ( ... )`). The
 *        operand is the import PATH; the local binding (alias `package_identifier`, blank `_`,
 *        dot `.`) is the binding and is NEVER the target — every form names the same real package
 *        path. Usage-site nodes (`pkg.Func` selectors, embedding) never refine an edge (v1
 *        enforces existence, not relation type) → no usage-site emission.
 *   GO2  Resolution is by FULL import path: strip the go.mod `module` prefix to get the
 *        repo-relative package DIRECTORY, then pick a representative production `.go` file in
 *        EXACTLY that directory. The full path pins the directory, so a same-LEAF directory
 *        elsewhere is structurally unreachable — it can only be reached by its OWN full import
 *        path, never mis-chosen.
 *   GO3  An import path that is NOT the module path and NOT under `<module>/` is stdlib/external
 *        → SILENCE (no in-repo directory). This module-prefix gate is the single most important
 *        false-positive guard. A textual overlap that is not a path boundary (`example.com/main`
 *        vs module `example.com/m`) is NOT under the module → silence.
 *   GO4  A package directory split across 2+ graph nodes (the F20 case, sealed by 9f842659) has
 *        no single graph owner → owner-set silence, never an arbitrary one-file pick.
 *   GO5  Resolution reads the DIRECTORY, never the `package <name>` clause inside the files. A dir
 *        named `bar` whose files declare `package foo` is reached by the import path ending `/bar`
 *        (the dir), and the package name never misleads — there is no name-based path at all.
 *   GO6  candidate-parity invariant: every emitted reference is a ONE-ELEMENT candidate group
 *        (path languages never widen). Asserted at the end so the matrix can't break parity.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine current false-positive a matrix exposed and FIXED. The split-package
 *           owner-set FP was already sealed on this branch by 9f842659; this matrix RE-ASSERTS
 *           that seal (the GO4 split-package block) so it cannot regress. This matrix itself
 *           exposed NO new genuine FP — every other Go import form is already zero-FP by the
 *           full-path / module-prefix design, so the live rows are PASS / GAP and no further seal
 *           was required.
 */

const run = (code: string) => runExtractor(goExtractor, 'go', '.go', code);

/** The import-path specifiers emitted for a file — each `import_spec`'s path. */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// A reusable resolver-deps fixture: module `github.com/mod`, with a concrete in-repo package
// layout. Directories are keyed by their repo-relative POSIX path; each holds one representative
// `.go` file. The SAME-LEAF trap is `pkg/sub` vs `other/sub` (both end in `sub`).
const baseDeps: GoResolveDeps = {
  modulePathFor: () => 'github.com/mod',
  dirExists: (d) =>
    ['pkg/sub', 'other/sub', 'internal/x', 'bar'].includes(d) || d === '',
  goFilesIn: (d) => {
    if (d === 'pkg/sub') return ['pkg/sub/s.go'];
    if (d === 'other/sub') return ['other/sub/s.go'];
    if (d === 'internal/x') return ['internal/x/x.go'];
    if (d === 'bar') return ['bar/foo_impl.go']; // dir `bar`, files declare `package foo`
    if (d === '') return ['main.go']; // module-root package
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — standard / grouped imports (the import PATH IS the edge; resolves to a DIR)', () => {
  it('PASS GO1: single `import "github.com/mod/pkg/sub"` → emits the full import path', async () => {
    expect(specs((await run('package main\nimport "github.com/mod/pkg/sub"\n')).uses)).toEqual([
      'github.com/mod/pkg/sub',
    ]);
  });

  it('PASS GO1: grouped `import ( "a/b" \\n "c/d/e" )` → one edge per path', async () => {
    const s = specs((await run('package main\nimport (\n  "a/b"\n  "c/d/e"\n)\n')).uses);
    expect(s).toContain('a/b');
    expect(s).toContain('c/d/e');
    expect(s).toHaveLength(2);
  });

  it('PASS GO2: `github.com/mod/pkg/sub` resolves to the package DIR `pkg/sub/` by full path', () => {
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', baseDeps)).toBe('pkg/sub/s.go');
  });

  it('PASS GO2 (same-LEAF trap): `github.com/mod/other/sub` resolves to `other/sub/`, NEVER `pkg/sub/`', () => {
    // The full import path pins the directory. `other/sub` and `pkg/sub` share the LEAF `sub`
    // but are distinct directories — resolution is by full path, not by the last segment, so the
    // leaf collision can never mis-bind. Each path reaches ONLY its own directory.
    expect(resolveGoImport('github.com/mod/other/sub', 'app/main.go', baseDeps)).toBe(
      'other/sub/s.go',
    );
  });

  it('PASS GO2: the module ROOT import `github.com/mod` resolves to a `.go` file at the root dir', () => {
    expect(resolveGoImport('github.com/mod', 'app/main.go', baseDeps)).toBe('main.go');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — local-binding forms (alias / dot / blank — the binding is irrelevant to the edge)', () => {
  it('PASS GO1: aliased `import alias "github.com/mod/pkg"` → the PATH, never the alias', async () => {
    const s = specs((await run('package main\nimport alias "github.com/mod/pkg"\n')).uses);
    expect(s).toContain('github.com/mod/pkg');
    expect(s).not.toContain('alias');
  });

  it('PASS GO1: dot-import `import . "github.com/mod/pkg"` → still a real dependency on the path', async () => {
    // A dot-import merges the package's exported names into the file scope; it is a genuine
    // runtime dependency on that package directory.
    expect(specs((await run('package main\nimport . "github.com/mod/pkg"\n')).uses)).toEqual([
      'github.com/mod/pkg',
    ]);
  });

  it('PASS GO1: blank import `import _ "github.com/mod/driver"` → side-effect dependency, real edge', async () => {
    // A blank import runs the package's `init()` for its side effects (driver registration); the
    // dependency on that package directory is real even though no name is bound.
    expect(specs((await run('package main\nimport _ "github.com/mod/driver"\n')).uses)).toEqual([
      'github.com/mod/driver',
    ]);
  });

  it('PASS GO1: grouped block mixing plain / alias / blank / dot + a stdlib name → one edge each', async () => {
    const s = specs(
      (
        await run(
          'package main\nimport (\n  "fmt"\n  pay "github.com/mod/billing"\n  _ "github.com/mod/driver"\n  . "github.com/mod/dsl"\n)\n',
        )
      ).uses,
    );
    expect(s).toEqual(
      expect.arrayContaining([
        'fmt',
        'github.com/mod/billing',
        'github.com/mod/driver',
        'github.com/mod/dsl',
      ]),
    );
    expect(s).toHaveLength(4);
    expect(s).not.toContain('pay'); // alias never emitted
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — stdlib / external (no module-prefix match → SILENCE, the most important FP guard)', () => {
  it('PASS GO3: stdlib `import "fmt"` → emitted as a specifier but resolves to SILENCE (not in-repo)', async () => {
    // The extractor emits `fmt` (it cannot know it is stdlib); the resolver gates it: `fmt` is
    // not the module path nor under `<module>/` → undefined. No in-repo edge.
    expect(specs((await run('package main\nimport "fmt"\n')).uses)).toEqual(['fmt']);
    expect(resolveGoImport('fmt', 'app/main.go', baseDeps)).toBeUndefined();
  });

  it('PASS GO3: stdlib `import "strings"` → resolves to SILENCE', () => {
    expect(resolveGoImport('strings', 'app/main.go', baseDeps)).toBeUndefined();
  });

  it('PASS GO3: external module `import "golang.org/x/tools/..."` → SILENCE (prefix is not the module)', () => {
    expect(resolveGoImport('golang.org/x/tools/go/packages', 'app/main.go', baseDeps)).toBeUndefined();
  });

  it('PASS GO3: external `import "github.com/gorilla/mux"` → SILENCE (different module prefix)', async () => {
    expect(specs((await run('package main\nimport "github.com/gorilla/mux"\n')).uses)).toEqual([
      'github.com/gorilla/mux',
    ]);
    expect(resolveGoImport('github.com/gorilla/mux', 'app/main.go', baseDeps)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — module-prefix strip (only paths under the module dir are graph-resolvable)', () => {
  it('PASS GO3: a path UNDER the module (`<module>/pkg/sub`) strips to the repo-relative dir', () => {
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', baseDeps)).toBe('pkg/sub/s.go');
  });

  it('PASS GO3 (non-boundary overlap trap): `github.com/module-x/pkg` shares a text prefix but is NOT under `github.com/mod` → SILENCE', () => {
    // `github.com/module-x` textually starts with `github.com/mod` but the next char is NOT `/`,
    // so it is a DIFFERENT module, not a sub-path of ours. The `startsWith(module + '/')` boundary
    // check rejects it → silence (never a mis-rooted edge into our tree).
    expect(resolveGoImport('github.com/module-x/pkg', 'app/main.go', baseDeps)).toBeUndefined();
  });

  it('PASS GO3: no go.mod (module path unknown) → SILENCE for everything', () => {
    const noMod: GoResolveDeps = { ...baseDeps, modulePathFor: () => undefined };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', noMod)).toBeUndefined();
  });

  it('PASS GO3: an in-module path whose directory does not exist → SILENCE', () => {
    expect(resolveGoImport('github.com/mod/pkg/nope', 'app/main.go', baseDeps)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — internal/ packages (Go visibility is a compile rule, not a resolution change)', () => {
  it('PASS GO1: `import "github.com/mod/internal/x"` → emits the path (internal is just a path segment)', async () => {
    expect(specs((await run('package main\nimport "github.com/mod/internal/x"\n')).uses)).toEqual([
      'github.com/mod/internal/x',
    ]);
  });

  it('PASS GO2: an `internal/` import resolves like any other path → `internal/x/`', () => {
    // Go's `internal/` visibility (only importable by packages rooted at internal's parent) is a
    // COMPILER rule, not a resolution change. The dependency edge is identical to any package dir.
    expect(resolveGoImport('github.com/mod/internal/x', 'app/main.go', baseDeps)).toBe(
      'internal/x/x.go',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — package name != directory name (resolution is by DIR, the package clause never misleads)', () => {
  it('PASS GO5: import path ending `/bar` resolves to dir `bar/` even though its files declare `package foo`', () => {
    // Go resolution is by PATH = directory. The import path uses the DIRECTORY name (`bar`), not
    // the `package foo` clause inside the files. The resolver lists `bar/`'s `.go` files and never
    // reads their package clause, so the differing package name cannot mislead it to another dir.
    expect(resolveGoImport('github.com/mod/bar', 'app/main.go', baseDeps)).toBe('bar/foo_impl.go');
  });

  it('PASS GO5 (trap): there is NO path keyed by the package name — an import of `github.com/mod/foo` (the package name) → SILENCE', () => {
    // The package is `foo` but lives in dir `bar`. A naive name-based resolver might map the
    // import to a phantom `foo/` directory. Path-based resolution has no `foo/` dir on disk →
    // silence. The package name is never a resolution key.
    expect(resolveGoImport('github.com/mod/foo', 'app/main.go', baseDeps)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — split package across nodes (SEALED 9f842659: owner-set silence, package granularity)', () => {
  it('SEALED GO4: a package dir split across 2+ owners → SILENCE, never an arbitrary one-file pick', () => {
    // GENUINE FP sealed on this branch by 9f842659, RE-ASSERTED here so it cannot regress.
    // `pkg/sub` holds two production files owned by DIFFERENT nodes (s.go→x, t.go→y). A single
    // representative file cannot stand in for a split package — attributing the import to either
    // owner would fabricate or hide a cross-node edge. With 2+ distinct owners the import resolves
    // to nothing.
    const split: GoResolveDeps = {
      ...baseDeps,
      goFilesIn: (d) => (d === 'pkg/sub' ? ['pkg/sub/s.go', 'pkg/sub/t.go'] : []),
      ownerOf: (f) => (f === 'pkg/sub/s.go' ? 'x' : f === 'pkg/sub/t.go' ? 'y' : undefined),
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', split)).toBeUndefined();
  });

  it('PASS GO4 (the seal does NOT over-silence): a SINGLE-owner package resolves to its representative file', () => {
    // The trap beside the seal: when ALL files in the dir belong to ONE node, the owner set is a
    // singleton and the legit cross-node edge still resolves. The owner-set guard must not blanket
    // -silence Go resolution.
    const single: GoResolveDeps = {
      ...baseDeps,
      goFilesIn: (d) => (d === 'pkg/sub' ? ['pkg/sub/s.go', 'pkg/sub/t.go'] : []),
      ownerOf: () => 'x',
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', single)).toBe('pkg/sub/s.go');
  });

  it('PASS GO4 (wholly-unmapped package): no file mapped → owner set empty → falls through to the first candidate (downstream D7 silence)', () => {
    // When ownerOf is supplied but NO file in the package is mapped, the owner set is empty; the
    // resolver returns the first candidate and the unmapped target is silenced downstream (D7).
    // This is NOT a split — it is a coverage gap, never an FP here.
    const unmapped: GoResolveDeps = {
      ...baseDeps,
      goFilesIn: (d) => (d === 'pkg/sub' ? ['pkg/sub/s.go', 'pkg/sub/t.go'] : []),
      ownerOf: () => undefined,
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', unmapped)).toBe('pkg/sub/s.go');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — production vs test files in a package directory', () => {
  it('PASS GO2: a production `.go` is preferred over a `*_test.go` representative', () => {
    const mixed: GoResolveDeps = {
      ...baseDeps,
      goFilesIn: (d) => (d === 'pkg/sub' ? ['pkg/sub/s.go', 'pkg/sub/s_test.go'] : []),
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', mixed)).toBe('pkg/sub/s.go');
  });

  it('PASS GO2: a directory with ONLY `*_test.go` falls back to a test file (a real package still exists)', () => {
    const onlyTest: GoResolveDeps = {
      ...baseDeps,
      goFilesIn: (d) => (d === 'pkg/sub' ? ['pkg/sub/x_test.go'] : []),
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', onlyTest)).toBe(
      'pkg/sub/x_test.go',
    );
  });

  it('PASS GO3: an in-module directory with NO `.go` file → SILENCE (no package there)', () => {
    const empty: GoResolveDeps = {
      ...baseDeps,
      dirExists: (d) => d === 'pkg/sub' || d === '',
      goFilesIn: () => [],
    };
    expect(resolveGoImport('github.com/mod/pkg/sub', 'app/main.go', empty)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — vendored imports (vendor/ rewriting not modeled → tolerated recall GAP, never an FP)', () => {
  it('GAP: a standard vendored import `import "github.com/x/y"` → SILENCE (no vendor/ path rewrite)', () => {
    // Go's vendoring resolves a bare external import `github.com/x/y` to the on-disk directory
    // `vendor/github.com/x/y`. The resolver does NOT model this rewrite: the bare external path is
    // not under the repo's own module prefix, so it is silenced like any external import. Missing a
    // vendored in-tree dependency is a tolerated false-NEGATIVE (vendored code is third-party and
    // rarely a graph node); it can NEVER mis-bind — the rewrite that would reach `vendor/` is
    // simply not performed, so there is no path to a wrong file.
    const vendored: GoResolveDeps = {
      ...baseDeps,
      dirExists: (d) => d === 'vendor/github.com/x/y' || d === '',
      goFilesIn: (d) => (d === 'vendor/github.com/x/y' ? ['vendor/github.com/x/y/y.go'] : []),
    };
    expect(resolveGoImport('github.com/x/y', 'app/main.go', vendored)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — empty / malformed import paths', () => {
  it('PASS GO1: an empty double-quoted import path `import ""` → emits NOTHING (empty-specifier guard)', async () => {
    expect((await run('package main\nimport ""\n')).uses).toHaveLength(0);
  });

  it('PASS GO1: an empty backtick (raw-string) import path → emits NOTHING', async () => {
    expect((await run('package main\nimport ``\n')).uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — candidate-parity invariant (path languages emit ONE-ELEMENT groups, never widen)', () => {
  it('PASS GO6: every emitted reference across mixed import forms is a one-element path group', async () => {
    const { uses } = await run(
      [
        'package main',
        'import (',
        '  "fmt"',
        '  "github.com/mod/pkg/sub"',
        '  alias "github.com/mod/billing"',
        '  _ "github.com/mod/driver"',
        '  . "github.com/mod/dsl"',
        ')',
      ].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });
});
