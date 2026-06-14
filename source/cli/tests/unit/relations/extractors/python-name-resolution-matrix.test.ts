import { describe, it, expect } from 'vitest';
import { runExtractor } from './_harness.js';
import { pythonExtractor } from '../../../../src/relations/extractors/python.js';
import { resolvePythonModule } from '../../../../src/relations/extractors/python-resolve.js';

/**
 * PYTHON IMPORT-PATH IDENTIFICATION MATRIX — characterization, one `it()` per distinct Python
 * import identification form. Each test realizes the CONCRETE source for that exact case and
 * asserts the SPEC-CORRECT, zero-FP outcome. Two layers are exercised: the EXTRACTOR (which
 * module-path SPECIFIERS an import statement emits) and the RESOLVER (which repo-relative FILE
 * a specifier maps to, over a fixed known-set). For every resolving PATH form the same-name
 * FP-trap variant (a same-basename module in ANOTHER directory that must NOT be chosen) sits
 * beside the positive.
 *
 * THE GROUP B (path-based) DECISION (.plans/2026-06-14-import-only-languages-decision.md):
 * Python resolves imports to FILES by module-path = file-path, NOT by namespace-relative
 * simple-NAME binding. There is no §-precedence simple-name trap (that drives the symbol
 * languages). The FP risks are module-RESOLUTION-specific and Python-shaped:
 *   - an absolute `import a.b.c` mis-rooted to the importer's own / an intermediate dir
 *     (the 902bec0f shadowing case),
 *   - a `from a.b import c` NAME mis-resolved to a phantom submodule `a/b/c.py`,
 *   - a relative import that climbs above the repo root and mis-binds to a same-named file,
 *   - a stdlib/third-party name mapped to an in-repo file it is not.
 * The cardinal invariant — ZERO false positives, a hard wall with no adopter waiver —
 * outranks recall; a missed edge is a tolerated false-NEGATIVE.
 *
 * The zero-FP policy realized here:
 *   PY1  Only `import_statement` / `import_from_statement` is an edge. The operand is a MODULE
 *        PATH; the alias is the local binding and is NEVER the target. Usage-site nodes (class
 *        bases, decorators, calls) never refine an edge (v1 enforces existence, not relation
 *        type) → silent.
 *   PY2  `from a.b import c` emits BOTH `a.b` (the package/module edge) and `a.b.c` (the
 *        submodule longest-match candidate), each as its OWN one-element group. The resolver
 *        maps `a.b.c` to the real submodule file `a/b/c.py` when it exists, else FALLS BACK to
 *        the parent module `a/b.py` / `a/b/__init__.py` — NEVER a phantom `a/b/c.py`. Both
 *        candidates resolving to the same parent file is one logical edge (deduped downstream
 *        by file→node), never an FP.
 *   PY3  Absolute resolution probes EVERY ancestor source root and collects DISTINCT files; a
 *        single distinct match resolves, 2+ distinct matches are AMBIGUOUS → silence. The
 *        importer's own dir and intermediate dirs are not genuine roots, so a same-named module
 *        in the importer's own package never shadows the real root (902bec0f).
 *   PY4  Relative resolution climbs by dot-count from the importing file's package dir; a climb
 *        ABOVE the repo root is detected and silenced — never a mis-bind to a same-named file.
 *        The relative join pins the directory, so a same-basename sibling in another dir is
 *        structurally unreachable.
 *   PY5  Dynamic forms (`importlib.import_module('a.b')`, `__import__('x')`) are CALLS, never
 *        import statements — the string argument is never read → silent (an emitted edge there
 *        would be a guess = FP).
 *   PY6  Stdlib / third-party names emit a specifier but resolve to nothing IN-REPO → silence.
 *        A same-named in-repo file IS a real dependency (path-based), not an FP.
 *   PY7  RESOLUTION MISS → undefined: every specifier whose file is absent from the resolution
 *        universe is silently dropped — the single most important false-positive guard.
 *   PY8  candidate-parity invariant: every emitted reference is a ONE-ELEMENT candidate group
 *        (path languages never widen). Asserted at the end so the matrix can't break parity.
 *
 * PASS    → the extractor / resolver already does the spec-correct zero-FP thing (live `it`).
 * GAP     → a deliberate tolerated false-NEGATIVE (silence) per the decision doc (live `it`,
 *           asserting the silence; the suite stays green and documents the boundary).
 * SEALED  → a genuine current false-positive a matrix exposed and FIXED. The self/intermediate
 *           -dir absolute-import shadowing FP was already sealed on this branch by 902bec0f;
 *           this matrix RE-ASSERTS that seal (the PY3 absolute-shadowing block) so it cannot
 *           regress. This matrix itself exposed NO new genuine FP — every other form is already
 *           zero-FP, so the live rows are PASS / GAP, no further seal was required.
 */

const run = (code: string) => runExtractor(pythonExtractor, 'python', '.py', code);

/** The module-path specifiers emitted for a file — each import statement's specifier. */
const specs = (uses: Awaited<ReturnType<typeof run>>['uses']): string[] =>
  uses.flatMap((u) => (u.candidates[0].kind === 'path' ? [u.candidates[0].specifier] : []));

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — absolute imports (module-path = file-path; the specifier IS the edge)', () => {
  it('PASS PY1: plain `import a.b.c` → emits the dotted module specifier `a.b.c`', async () => {
    expect(specs((await run('import a.b.c')).uses)).toEqual(['a.b.c']);
  });

  it('PASS PY1: multiple `import a, b.c` → one specifier per module', async () => {
    const s = specs((await run('import a, b.c')).uses);
    expect(s).toContain('a');
    expect(s).toContain('b.c');
  });

  it('PASS PY1: aliased `import a.b as ab` → the real module `a.b`, NEVER the alias `ab`', async () => {
    const s = specs((await run('import a.b as ab')).uses);
    expect(s).toContain('a.b');
    expect(s).not.toContain('ab');
  });

  it('PASS PY3: `import a.b.c` → resolves to the submodule FILE `a/b/c.py`', () => {
    const known = new Set(['a/b/c.py']);
    expect(resolvePythonModule('a.b.c', 'main.py', (p) => known.has(p))).toBe('a/b/c.py');
  });

  it('PASS PY3: `import a.b.c` → resolves to a PACKAGE `a/b/c/__init__.py` when that is what exists', () => {
    const known = new Set(['a/b/c/__init__.py']);
    expect(resolvePythonModule('a.b.c', 'main.py', (p) => known.has(p))).toBe('a/b/c/__init__.py');
  });

  it('PASS PY7: `import a.b.c` with no in-repo file → SILENCE (resolution miss)', () => {
    expect(resolvePythonModule('a.b.c', 'main.py', () => false)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — absolute root shadowing (SEALED 902bec0f: own/intermediate dir must not mis-root)', () => {
  it('SEALED PY3 (own-dir shadow): `import b.bar` where the importer is src/a/b.py → AMBIGUOUS → SILENCE', () => {
    // GENUINE FP sealed on this branch by 902bec0f, RE-ASSERTED here so it cannot regress.
    // Importing file src/a/b.py does an absolute `from b.bar import x`. The genuine source
    // root is src/ → src/b/bar.py (a real cross-node target). But the importer's OWN dir
    // src/a/ also "roots" the parent module b → src/a/b.py (the importing file itself). Two
    // DISTINCT files match across roots; the resolver cannot tell which root is genuine →
    // SILENCE (never the nearer self). Picking src/a/b.py would be a false self-edge.
    const shadow = new Set(['src/a/b.py', 'src/b/bar.py']);
    expect(resolvePythonModule('b.bar', 'src/a/b.py', (p) => shadow.has(p))).toBeUndefined();
  });

  it('SEALED PY3 (intermediate-dir shadow): `import pkg.mod` from src/pkg/a/c.py → AMBIGUOUS → SILENCE', () => {
    // The intermediate dir src/pkg/ also roots pkg.mod → src/pkg/pkg/mod.py alongside the
    // genuine src/ root → src/pkg/mod.py. Two distinct files → silence.
    const shadow = new Set(['src/pkg/pkg/mod.py', 'src/pkg/mod.py']);
    expect(resolvePythonModule('pkg.mod', 'src/pkg/a/c.py', (p) => shadow.has(p))).toBeUndefined();
  });

  it('PASS PY3 (the seal does NOT over-silence): single genuine root → resolves the real cross-node edge', () => {
    // The trap beside the seal: when ONLY the genuine target exists (no self/intermediate
    // shadow), the distinct-set is a singleton and the legit cross-node edge still resolves.
    const clean = new Set(['src/b/bar.py']);
    expect(resolvePythonModule('b.bar', 'src/a/foo.py', (p) => clean.has(p))).toBe('src/b/bar.py');
  });

  it('PASS PY3 (same-name trap): same dotted module under 2+ distinct roots → SILENCE, never an arbitrary pick', () => {
    // A pure ambiguity: a.mod exists under both the importer dir root and an ancestor root as
    // two distinct files. Two distinct hits → silence (the analyzer must not guess a root).
    const trap = new Set(['src/a/a/mod.py', 'src/a/mod.py']);
    expect(resolvePythonModule('a.mod', 'src/a/use.py', (p) => trap.has(p))).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — from-import (the key Python subtlety: submodule vs name → never a phantom)', () => {
  it('PASS PY2: `from a.b import c` → emits BOTH the module `a.b` and the submodule candidate `a.b.c`', async () => {
    const s = specs((await run('from a.b import c')).uses);
    expect(s).toContain('a.b');
    expect(s).toContain('a.b.c');
  });

  it('PASS PY2 (submodule): `from a.b import c` where c IS a submodule → `a.b.c` resolves to `a/b/c.py`', () => {
    const known = new Set(['a/b/c.py']);
    expect(resolvePythonModule('a.b.c', 'main.py', (p) => known.has(p))).toBe('a/b/c.py');
  });

  it('PASS PY2 (name in module): `from a.b import c` where c is a NAME in a/b.py → `a.b.c` falls back to `a/b.py`, NEVER a phantom `a/b/c.py`', () => {
    // The key from-import ambiguity. `c` is a class/function defined inside a/b.py, NOT a
    // submodule file. The longest-match `a.b.c` finds no a/b/c.py and falls back to the PARENT
    // module a/b.py (the file that actually defines `c`). The edge is to the real module file,
    // never an invented a/b/c.py — that phantom would be the FP this resolution avoids.
    const known = new Set(['a/b.py']);
    expect(resolvePythonModule('a.b.c', 'main.py', (p) => known.has(p))).toBe('a/b.py');
    // And there is no a/b/c.py in the universe at all — the phantom is structurally absent.
    expect(known.has('a/b/c.py')).toBe(false);
  });

  it('PASS PY2 (name in package): `from a.b import c` where the parent is a package → `a.b.c` falls back to `a/b/__init__.py`', () => {
    const known = new Set(['a/b/__init__.py']);
    expect(resolvePythonModule('a.b.c', 'main.py', (p) => known.has(p))).toBe('a/b/__init__.py');
  });

  it('PASS PY2 (one logical edge): both `a.b` and `a.b.c` resolve to the SAME parent file → one node edge, no double-emit FP', async () => {
    // For the name case both emitted specifiers map to the same parent module file. Downstream
    // dedupes by resolved file → node, so two specifiers collapse to one logical dependency.
    const { uses } = await run('from a.b import c');
    const known = new Set(['a/b.py']);
    const resolved = specs(uses).map((sp) => resolvePythonModule(sp, 'main.py', (p) => known.has(p)));
    // Every resolved entry is the same parent file (no phantom a/b/c.py among them).
    expect(new Set(resolved.filter((r) => r !== undefined))).toEqual(new Set(['a/b.py']));
  });

  it('PASS PY1: aliased `from a import b as c` → real symbol `a.b`, never the alias `a.c`', async () => {
    const s = specs((await run('from a import b as c')).uses);
    expect(s).toContain('a');
    expect(s).toContain('a.b');
    expect(s).not.toContain('a.c');
  });

  it('PASS PY2: multiple `from a.b import C, D` → module edge + a submodule candidate per name', async () => {
    const s = specs((await run('from a.b import C, D')).uses);
    expect(s).toContain('a.b');
    expect(s).toContain('a.b.C');
    expect(s).toContain('a.b.D');
  });

  it('PASS PY2: parenthesized `from a.b import (x, y, z)` → module edge + one candidate per name, no phantom', async () => {
    const s = specs((await run('from a.b import (x, y, z)')).uses);
    expect(s).toContain('a.b');
    expect(s).toContain('a.b.x');
    expect(s).toContain('a.b.y');
    expect(s).toContain('a.b.z');
  });

  it('PASS PY2 (same-name trap): `from a.b import c` never resolves to a same-named `a/b/c.py` under a DIFFERENT root', () => {
    // The from-import submodule candidate a.b.c resolves under the importer's roots only. A
    // same-named c.py under an unrelated path (not reachable as a root-anchored a/b/c.py) is
    // never chosen. Here a/b/c.py exists under exactly one anchoring → resolves it; a decoy
    // x/a/b/c.py is unreachable because no root makes `a.b.c` land there.
    const known = new Set(['a/b/c.py']);
    expect(resolvePythonModule('a.b.c', 'src/use.py', (p) => known.has(p))).toBe('a/b/c.py');
    // The decoy under another tree is never produced by the root walk for this importer.
    const decoyOnly = new Set(['x/a/b/c.py']);
    expect(resolvePythonModule('a.b.c', 'src/use.py', (p) => decoyOnly.has(p))).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — package __init__.py resolution', () => {
  it('PASS PY3: importing a PACKAGE resolves to its `__init__.py` — `import pkg` → `src/pkg/__init__.py`', () => {
    const known = new Set(['src/pkg/__init__.py']);
    expect(resolvePythonModule('pkg', 'src/a/c.py', (p) => known.has(p))).toBe('src/pkg/__init__.py');
  });

  it('PASS PY2: `from a.nope import x` where nope is a name in package a → falls back to `a/__init__.py`', () => {
    // nope is not a submodule file; the package a (src/a/__init__.py) is the owning file.
    const known = new Set(['src/a/__init__.py']);
    expect(resolvePythonModule('a.nope', 'src/a/c.py', (p) => known.has(p))).toBe('src/a/__init__.py');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — relative imports (climb by dot-count; escape → SILENCE, join pins the dir)', () => {
  it('PASS PY1: `from . import x` → emits `.x` (and the bare-dots package `.`)', async () => {
    const s = specs((await run('from . import x')).uses);
    expect(s).toContain('.x');
    expect(s).toContain('.');
  });

  it('PASS PY1: `from .mod import y` → emits `.mod` and the submodule candidate `.mod.y`', async () => {
    const s = specs((await run('from .mod import y')).uses);
    expect(s).toContain('.mod');
    expect(s).toContain('.mod.y');
  });

  it('PASS PY1: `from ..pkg import z` → emits `..pkg` and `..pkg.z`', async () => {
    const s = specs((await run('from ..pkg import z')).uses);
    expect(s).toContain('..pkg');
    expect(s).toContain('..pkg.z');
  });

  it('PASS PY1: `from ...deep import w` → emits the 3-dot relative path `...deep`', async () => {
    const s = specs((await run('from ...deep import w')).uses);
    expect(s).toContain('...deep');
    expect(s).toContain('...deep.w');
  });

  it('PASS PY4: `.sib` (one dot, same package) → resolves under the importing dir → `src/a/sib.py`', () => {
    const known = new Set(['src/a/sib.py']);
    expect(resolvePythonModule('.sib', 'src/a/use.py', (p) => known.has(p))).toBe('src/a/sib.py');
  });

  it('PASS PY4: bare `.` → the importing package `__init__.py` → `src/a/__init__.py`', () => {
    const known = new Set(['src/a/__init__.py']);
    expect(resolvePythonModule('.', 'src/a/x.py', (p) => known.has(p))).toBe('src/a/__init__.py');
  });

  it('PASS PY4: `..pkg.mod` (two dots) → climbs one parent → `src/a/pkg/mod.py` from src/a/b/c.py', () => {
    const known = new Set(['src/a/pkg/mod.py']);
    expect(resolvePythonModule('..pkg.mod', 'src/a/b/c.py', (p) => known.has(p))).toBe('src/a/pkg/mod.py');
  });

  it('PASS PY4 (exact-root): `...deep` lands EXACTLY at the repo root → resolves `deep.py` (a legit climb, not an escape)', () => {
    // 3 dots from src/a/x.py: own pkg src/a → src → repo root. `deep` at root is reachable.
    const known = new Set(['deep.py']);
    expect(resolvePythonModule('...deep', 'src/a/x.py', (p) => known.has(p))).toBe('deep.py');
  });

  it('GAP/PY4 (escape trap): too many dots `....deep` climbs ABOVE the repo root → SILENCE, never mis-roots', () => {
    // 4 dots from a 2-deep file escapes above the root. The climb guard fires; even with a
    // same-named deep.py at the root the resolver returns undefined — never a mis-bind.
    const known = new Set(['deep.py', 'src/deep.py', 'src/a/deep.py']);
    expect(resolvePythonModule('....deep', 'src/a/x.py', (p) => known.has(p))).toBeUndefined();
  });

  it('GAP/PY4 (escape trap): bare `..` from a repo-root file climbs above the root → SILENCE', () => {
    const known = new Set(['__init__.py']);
    expect(resolvePythonModule('..', 'x.py', (p) => known.has(p))).toBeUndefined();
  });

  it('PASS PY4 (same-name trap): `.sib` binds the importer-dir sibling, NEVER a same-named sib in another dir', () => {
    // The relative join pins the directory to the importer's package. A same-basename
    // src/other/sib.py is structurally unreachable from src/a/use.py — only src/a/sib.py is.
    const trap = new Set(['src/a/sib.py', 'src/other/sib.py']);
    expect(resolvePythonModule('.sib', 'src/a/use.py', (p) => trap.has(p))).toBe('src/a/sib.py');
  });

  it('PASS PY7: a relative target that does not exist → SILENCE', () => {
    expect(resolvePythonModule('.missing', 'src/a/x.py', () => false)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — star imports (real dependency on the module → emit the module, no symbol enumeration)', () => {
  it('PASS PY1: `from a.b import *` → emits ONE specifier `a.b` (the star symbols are not enumerable)', async () => {
    const s = specs((await run('from a.b import *')).uses);
    expect(s).toContain('a.b');
    // No `a.b.*` or enumerated-symbol candidates — the wildcard never widens to a phantom.
    expect(s.every((x) => !x.includes('*'))).toBe(true);
  });

  it('PASS PY3: `from a.b import *` → the `a.b` edge resolves to the real module file `a/b.py`', () => {
    const known = new Set(['a/b.py']);
    expect(resolvePythonModule('a.b', 'main.py', (p) => known.has(p))).toBe('a/b.py');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — dynamic imports (string/dynamic → MUST be SILENT; never a guessed edge)', () => {
  it('GAP/PY5: `importlib.import_module("a.b")` → the string arg is NEVER an import edge (only the `import importlib` stmt is seen)', async () => {
    const s = specs((await run("import importlib\nm = importlib.import_module('a.b')")).uses);
    // The dynamic target string 'a.b' is never extracted — no phantom `a.b` edge from the call.
    expect(s).not.toContain('a.b');
    // The only specifier is the literal `import importlib` statement (stdlib → resolves to
    // silence in any real repo); the matrix asserts the call itself contributes nothing.
    expect(s).toEqual(['importlib']);
  });

  it('GAP/PY5: `__import__("x")` → SILENT (a bare call, never an import statement)', async () => {
    const { uses } = await run("m = __import__('x')");
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — conditional imports (both branches are real static imports → both edges)', () => {
  it('PASS PY1: `try: import a / except: import b` → BOTH `a` and `b` emitted (each a real static import)', async () => {
    const s = specs((await run('try:\n    import a\nexcept ImportError:\n    import b')).uses);
    expect(s).toContain('a');
    expect(s).toContain('b');
  });

  it('PASS PY1: a function-local `import lazy_mod` is still a static import statement → emitted', async () => {
    const s = specs((await run('def f():\n    import lazy_mod\n    return lazy_mod')).uses);
    expect(s).toContain('lazy_mod');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — stdlib / third-party (emit a specifier, but resolve to nothing in-repo → SILENCE)', () => {
  it('PASS PY6: `import os` → emits `os` but resolves to SILENCE when no in-repo `os` module exists', async () => {
    const s = specs((await run('import os')).uses);
    expect(s).toEqual(['os']);
    expect(resolvePythonModule('os', 'src/a/c.py', () => false)).toBeUndefined();
  });

  it('PASS PY6: third-party `import numpy as np` → emits `numpy` (not the alias), resolves to SILENCE off-repo', async () => {
    const s = specs((await run('import numpy as np')).uses);
    expect(s).toEqual(['numpy']);
    expect(s).not.toContain('np');
    expect(resolvePythonModule('numpy', 'src/a/c.py', () => false)).toBeUndefined();
  });

  it('PASS PY6 (in-repo same-name is a REAL dep, not an FP): an in-repo module shadowing a stdlib name resolves to its file', () => {
    // Path-based truth: if the repo genuinely contains a module whose name collides with a
    // stdlib name AND it is the single distinct match, importing it IS a real in-repo
    // dependency on that file — emitting the edge is correct, not an FP. (Contrast PY6 above
    // where no in-repo file exists → silence.)
    const known = new Set(['src/a/mymod.py']);
    expect(resolvePythonModule('mymod', 'src/a/c.py', (p) => known.has(p))).toBe('src/a/mymod.py');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — future-import pseudo-module (distinct node type → never an edge)', () => {
  it('PASS PY1: `from __future__ import annotations` → SILENT (future_import_statement, never import_from_statement)', async () => {
    const { uses } = await run('from __future__ import annotations');
    expect(uses).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('MATRIX — candidate-parity invariant (path languages emit ONE-ELEMENT groups, never widen)', () => {
  it('PASS PY8: every emitted reference across mixed import forms is a one-element path group', async () => {
    const { uses } = await run(
      [
        'import a.b.c',
        'import x as y',
        'from a.b import c, d',
        'from a.b import (e, f)',
        'from . import sib',
        'from ..pkg.mod import g',
        'from a.b import *',
        'try:\n    import opt\nexcept ImportError:\n    import alt',
      ].join('\n'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const dep of uses) {
      expect(dep.candidates).toHaveLength(1);
      expect(dep.candidates[0].kind).toBe('path');
    }
  });
});
