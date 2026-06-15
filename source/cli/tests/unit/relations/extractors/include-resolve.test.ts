import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';

// The C/C++ include resolver maps a QUOTED `#include "header"` path → a repo-relative
// file. A quoted include resolves ONLY relative to the including file's directory (canonical
// quoted-include semantics). A miss → undefined (silence). The old speculative include-root
// walk has been dropped to prevent false cross-node edges from same-basename decoys.
// These tests build a real temp tree and drive the production makeResolvePathToFile
// (disk-backed existence) for both the `c` and `cpp` language branches.

describe('resolveIncludePath via makeResolvePathToFile (disk-backed, C + C++)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'c-include-resolve-'));
    // src/a/foo.c  →  #include "../inc/bar.h"  resolves to src/inc/bar.h (relative).
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'inc'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a', 'foo.c'), '#include "../inc/bar.h"\n', 'utf-8');
    writeFileSync(path.join(root, 'src', 'inc', 'bar.h'), '/* bar */\n', 'utf-8');
    // A header reachable via the `include/` root convention from src/a (src/a/include/root.h),
    // and one via an ancestor `include/` dir (include/proj/widget.h at repo root).
    mkdirSync(path.join(root, 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'include', 'proj', 'widget.h'), '/* widget */\n', 'utf-8');
    // A header sitting bare at the repo root (no include/ dir), and a root-level
    // source file — for the include-root walk and the root-directory (fromDir === '.')
    // cases. cfg.h exists ONLY under <root>/include/, so a root-level includer misses
    // the relative join and reaches the include-root walk with the root start dir.
    writeFileSync(path.join(root, 'top.h'), '/* top */\n', 'utf-8');
    writeFileSync(path.join(root, 'main.c'), '#include "cfg.h"\n', 'utf-8');
    writeFileSync(path.join(root, 'include', 'cfg.h'), '/* cfg */\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a relative quoted include against the including file directory (C)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/bar.h', 'src/a/foo.c', 'c')).toBe('src/inc/bar.h');
  });

  it('resolves the same way for the cpp branch (shared resolver)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/bar.h', 'src/a/foo.cpp', 'cpp')).toBe('src/inc/bar.h');
  });

  it('does NOT resolve via an ancestor include/ root (speculative walk dropped)', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "proj/widget.h" is not under src/a. It exists only at
    // <root>/include/proj/widget.h — reachable solely through the old ancestor
    // include-root walk, which is gone. A real -Iinclude flag the resolver cannot
    // see would resolve this; without it we stay silent rather than guess.
    expect(resolve('proj/widget.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('returns undefined for a missing header (silence, never a guess)', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('../inc/missing.h', 'src/a/foo.c', 'c')).toBeUndefined();
    expect(resolve('nope/absent.h', 'src/a/foo.cpp', 'cpp')).toBeUndefined();
  });

  it('returns undefined for an empty specifier', () => {
    const resolve = makeResolvePathToFile(root);
    expect(resolve('', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('does NOT resolve an include/-only header for a repo-root source file (walk dropped)', () => {
    const resolve = makeResolvePathToFile(root);
    // main.c lives at the repo root; cfg.h exists only under <root>/include/cfg.h.
    // The canonical relative join (<root>/cfg.h) misses, and the speculative
    // include-root probe is gone → silence.
    expect(resolve('cfg.h', 'main.c', 'c')).toBeUndefined();
  });

  it('does NOT resolve a header bare at an ancestor root (walk dropped)', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "top.h" exists only as <root>/top.h — a same-basename
    // file at an ancestor root. The old walk would have grabbed it (a decoy);
    // the canonical-relative-only resolver returns undefined.
    expect(resolve('top.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });

  it('does NOT grab a same-basename decoy at an ancestor root when the relative join misses', () => {
    const resolve = makeResolvePathToFile(root);
    // src/a/foo.c includes "bar.h". A real sibling does NOT exist next to foo.c, but a
    // same-basename decoy lives at <root>/include/proj — created here to model the trap.
    mkdirSync(path.join(root, 'include', 'proj'), { recursive: true });
    writeFileSync(path.join(root, 'include', 'proj', 'bar.h'), '/* decoy */\n', 'utf-8');
    // The relative join <root>/src/a/bar.h misses; with the walk dropped, the decoy is
    // never reached → silence (the old resolver would have returned a wrong path).
    expect(resolve('bar.h', 'src/a/foo.c', 'c')).toBeUndefined();
  });
});
