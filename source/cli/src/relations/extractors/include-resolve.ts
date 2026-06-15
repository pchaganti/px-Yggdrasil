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
 * Resolution is the canonical quoted-include semantics ONLY: resolve relative to the
 * including file's directory (`<dir-of-includer>/<headerPath>`, normalized). A MISS →
 * undefined, i.e. SILENCE — the single most important false-positive guard, because real
 * includes resolve through compiler -I flags this resolver cannot see. We deliberately do
 * NOT probe speculative include roots (ancestor dirs or their `include/` subdirs): such a
 * probe can only match a same-basename decoy the compiler would not pick, which would
 * manufacture a false dependency edge. Handles the dominant cases `#include "sibling.h"`
 * and `#include "../inc/foo.h"`; a header reachable only via an unseen -I root stays silent.
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

  // The canonical quoted-include semantics: resolve relative to the including file's
  // directory only. A miss → undefined (silence). We deliberately do NOT probe
  // speculative include roots (ancestor dirs / `include/` subdirs): the real include
  // path is set by compiler -I flags this resolver cannot see, so an ancestor probe
  // can only ever match a SAME-BASENAME DECOY that the compiler would not pick —
  // manufacturing a false dependency edge. Silence on doubt (trade recall for zero
  // false positives) is the rule.
  const relative = normalizeRepoRel(path.posix.join(fromDir, headerPath));
  if (relative !== undefined && exists(relative)) return relative;

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
