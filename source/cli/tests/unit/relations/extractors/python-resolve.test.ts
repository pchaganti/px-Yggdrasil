import { describe, it, expect } from 'vitest';
import { resolvePythonModule } from '../../../../src/relations/extractors/python-resolve.js';

// `exists` predicate over a fixed set of repo-relative POSIX files.
const known = new Set([
  'src/a/b.py',
  'src/a/__init__.py',
  'src/a/pkg/mod.py',
  'src/a/sib.py',
  'src/pkg/__init__.py',
  'top.py',
]);
const exists = (p: string) => known.has(p);

describe('resolvePythonModule — absolute', () => {
  it('resolves a module file via an ancestor source root', () => {
    // Importing from src/a/c.py, module `a.b` lives at src/a/b.py (root = src/).
    expect(resolvePythonModule('a.b', 'src/a/c.py', exists)).toBe('src/a/b.py');
  });

  it('resolves a package to its __init__.py', () => {
    expect(resolvePythonModule('pkg', 'src/a/c.py', exists)).toBe('src/pkg/__init__.py');
  });

  it('resolves `from a import b` (last segment is a submodule file)', () => {
    // `from a import b` emits candidate `a.b` → src/a/b.py.
    expect(resolvePythonModule('a.b', 'src/x.py', exists)).toBe('src/a/b.py');
  });

  it('longest-match: `a.b.thing` falls back to the parent module a.b', () => {
    // No src/a/b/thing.py; the parent module a.b (src/a/b.py) is the owning file.
    expect(resolvePythonModule('a.b.thing', 'src/a/c.py', exists)).toBe('src/a/b.py');
  });

  it('resolves a top-level module at the repo root', () => {
    expect(resolvePythonModule('top', 'src/a/c.py', exists)).toBe('top.py');
  });

  it('returns undefined for a stdlib/third-party module (no mapped file)', () => {
    expect(resolvePythonModule('os', 'src/a/c.py', exists)).toBeUndefined();
    expect(resolvePythonModule('requests', 'src/a/c.py', exists)).toBeUndefined();
  });

  it('returns undefined for a non-existent module (no file, no resolvable parent)', () => {
    // `nope.deep`: neither nope/deep.py, nope/deep/__init__.py, nope.py, nor
    // nope/__init__.py exists at any source root → a true resolution miss.
    expect(resolvePythonModule('nope.deep', 'src/a/c.py', exists)).toBeUndefined();
  });

  it('longest-match: `a.nope` falls back to package `a` __init__ (nope may be a symbol there)', () => {
    // Documented behaviour: `from a import nope` where `nope` is not a submodule
    // file resolves to the package a (src/a/__init__.py); the symbol lives inside.
    expect(resolvePythonModule('a.nope', 'src/a/c.py', exists)).toBe('src/a/__init__.py');
  });
});

describe('resolvePythonModule — relative', () => {
  it('resolves `..pkg.mod` from src/a/b/c.py to src/a/pkg/mod.py', () => {
    expect(resolvePythonModule('..pkg.mod', 'src/a/b/c.py', exists)).toBe('src/a/pkg/mod.py');
  });

  it('resolves `.sib` (one dot, same package) from src/a/x.py to src/a/sib.py', () => {
    expect(resolvePythonModule('.sib', 'src/a/x.py', exists)).toBe('src/a/sib.py');
  });

  it('resolves a bare `.` to the importing package __init__', () => {
    expect(resolvePythonModule('.', 'src/a/x.py', exists)).toBe('src/a/__init__.py');
  });

  it('returns undefined when the relative climb escapes the repo', () => {
    expect(resolvePythonModule('....deep', 'src/a/x.py', exists)).toBeUndefined();
  });

  it('returns undefined when the relative target does not exist', () => {
    expect(resolvePythonModule('.missing', 'src/a/x.py', exists)).toBeUndefined();
  });
});
