import path from 'node:path';

/**
 * Resolve a QUOTED C/C++ `#include "header"` path to a repo-relative POSIX source file,
 * or undefined. Shared by both the C (`.c`/`.h`) and C++ (`.cpp`/`.hpp`/…) dispatch
 * branches — the include mechanism is identical across the two grammars.
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution
 * universe (disk at --approve time; a fixed known-set in unit tests). PURE except through
 * `exists`.
 *
 * HEADER/IMPL SPLIT: a quoted include always names the HEADER file (`foo.h` / `Foo.hpp`),
 * never the implementation translation unit. The resolved header's OWNING NODE is the
 * dependency target. For this to express the real dependency, a header and its
 * implementation (`foo.h` + `foo.c`, `Foo.hpp` + `Foo.cpp`) should live in the SAME node
 * (or both be mapped). When the header resolves to a file owned by no node, the owner
 * index maps it to nothing and the dependency is SILENT (a coverage matter, never a
 * violation) — the resolver's job ends at producing the file path.
 *
 * Resolution order (first existing candidate wins; a MISS → undefined, i.e. SILENCE — the
 * single most important false-positive guard, because real includes resolve through
 * compiler -I flags this resolver cannot see):
 *   1. Relative to the including file's directory: `<dir-of-includer>/<headerPath>`,
 *      normalized. This is the canonical meaning of a quoted include and the dominant
 *      case (`#include "../inc/foo.h"`, `#include "sibling.h"`).
 *   2. A few common include ROOTS, tried by walking up the includer's ancestor directories
 *      (nearest first): for each ancestor dir D, probe `<D>/<headerPath>` and
 *      `<D>/include/<headerPath>`. This covers the conventional `-Iinclude` /
 *      project-root include layouts without guessing arbitrary -I paths.
 *
 * Angle includes (`<stdio.h>`) and macro includes (`#include HDR`) never reach this
 * resolver — the extractor skips them — so a system/third-party header can never be
 * flagged.
 */
export function resolveIncludePath(
  headerPath: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  if (headerPath === '') return undefined;

  const fromDir = path.posix.dirname(toPosix(fromFile));

  // 1. Relative to the including file's directory (canonical quoted-include semantics).
  const relative = normalizeRepoRel(path.posix.join(fromDir, headerPath));
  if (relative !== undefined && exists(relative)) return relative;

  // 2. Common include roots: walk up the includer's ancestors (nearest first), probing
  //    `<ancestor>/<headerPath>` and `<ancestor>/include/<headerPath>`.
  let dir = fromDir === '.' ? '' : fromDir;
  for (;;) {
    const atRoot = normalizeRepoRel(dir === '' ? headerPath : path.posix.join(dir, headerPath));
    if (atRoot !== undefined && exists(atRoot)) return atRoot;

    const underInclude = normalizeRepoRel(path.posix.join(dir, 'include', headerPath));
    if (underInclude !== undefined && exists(underInclude)) return underInclude;

    if (dir === '') break; // reached the repo root
    const parent = path.posix.dirname(dir);
    dir = parent === '.' ? '' : parent;
  }

  return undefined; // miss → silence
}

/** Normalize a repo-relative POSIX path; reject any that escapes the repo root. */
function normalizeRepoRel(p: string): string | undefined {
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..')) return undefined;
  return norm;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
