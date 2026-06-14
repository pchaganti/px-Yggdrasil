import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { makeResolvePathToFile } from '../../../../src/relations/resolve-path.js';

// The C/C++ include resolver maps a QUOTED `#include "header"` path → a repo-relative
// file. A quoted include resolves first relative to the including file's directory, then
// against common include roots (walking up ancestors, also probing `<ancestor>/include/`).
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

  it('resolves via an ancestor include/ root when not found relative', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "proj/widget.h" is not under src/a; walking up to the repo root
    // probes <root>/include/proj/widget.h → match.
    expect(resolve('proj/widget.h', 'src/a/foo.c', 'c')).toBe('include/proj/widget.h');
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

  it('resolves an include/-only header for a source file at the repo root (fromDir === ".")', () => {
    const resolve = makeResolvePathToFile(root);
    // main.c lives at the repo root, so its directory is '.'. cfg.h is not relative to
    // the root, so resolution falls through to the include-root walk, which starts at
    // the root directory and probes <root>/include/cfg.h → match.
    expect(resolve('cfg.h', 'main.c', 'c')).toBe('include/cfg.h');
  });

  it('resolves a header bare at an ancestor root (no include/ dir on that hop)', () => {
    const resolve = makeResolvePathToFile(root);
    // From src/a/foo.c, "top.h" is not relative and not under any include/ dir; walking
    // up the ancestors the bare `<root>/top.h` probe matches before the include/ probe.
    expect(resolve('top.h', 'src/a/foo.c', 'c')).toBe('top.h');
  });
});
