import type { CoverageConfig } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';

/** Normalize a coverage root: POSIX, no leading/trailing slash. "/" → "" (whole repo). */
export function normalizeRoot(root: string): string {
  return toPosixPath(root.trim()).replace(/^\/+/, '').replace(/\/+$/, '');
}

/** A normalized root R matches file F iff R is "" (whole repo), or F === R, or F is under R/. */
export function matchesRoot(file: string, normRoot: string): boolean {
  return normRoot === '' || file === normRoot || file.startsWith(normRoot + '/');
}

/**
 * Split uncovered files into the error tier (longest match in `required`) and the
 * warning tier (no match). Files whose longest match is in `excluded` are dropped.
 * On an equal-length tie between required and excluded, excluded wins.
 */
export function partitionByCoverageTier(
  uncovered: string[],
  coverage: CoverageConfig,
): { required: string[]; middle: string[] } {
  const req = coverage.required.map(normalizeRoot);
  const exc = coverage.excluded.map(normalizeRoot);
  const required: string[] = [];
  const middle: string[] = [];
  for (const f of uncovered) {
    let best = { len: -1, tier: 'middle' as 'required' | 'excluded' | 'middle' };
    for (const r of req) if (matchesRoot(f, r) && r.length > best.len) best = { len: r.length, tier: 'required' };
    for (const r of exc) if (matchesRoot(f, r) && r.length >= best.len) best = { len: r.length, tier: 'excluded' };
    if (best.tier === 'required') required.push(f);
    else if (best.tier === 'middle') middle.push(f);
    // 'excluded' → silent
  }
  return { required, middle };
}
