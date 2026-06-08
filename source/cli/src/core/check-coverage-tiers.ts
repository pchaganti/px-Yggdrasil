import type { CoverageConfig } from '../model/graph.js';
import { toPosixPath } from '../utils/posix.js';
// type-only import — erased at runtime, no circular runtime dependency
import type { CheckIssue } from './check.js';

/** Normalize a coverage root: POSIX, no leading/trailing slash, collapse internal double-slashes. "/" → "" (whole repo). */
export function normalizeRoot(root: string): string {
  return toPosixPath(root.trim()).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
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

/**
 * Build the unmapped-files CheckIssue from uncovered files.
 * Aggregates into one error with count + sample.
 */
export function buildCoverageIssue(uncoveredFiles: string[], totalGitFiles: number): CheckIssue | null {
  if (uncoveredFiles.length === 0) return null;

  const sampleSize = 5;
  const sample = uncoveredFiles.slice(0, sampleSize);
  const remaining = uncoveredFiles.length - sample.length;

  // Learning tip for cold start
  const coveragePct = totalGitFiles > 0
    ? ((totalGitFiles - uncoveredFiles.length) / totalGitFiles) * 100
    : 100;

  let coverageMd;
  if (uncoveredFiles.length <= sampleSize) {
    // Small count: files listed directly, guidance after
    coverageMd = {
      what: `${uncoveredFiles.length} source file${uncoveredFiles.length === 1 ? '' : 's'} not covered by any node.\n${sample.map(f => '  ' + f).join('\n')}`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `Check ownership candidates: yg context --file <path>\nThen: add to existing node mapping, or create a new node.`,
    };
  } else {
    // Large count: guidance BEFORE examples (per CLI messages spec)
    const guidance = coveragePct < 50
      ? 'Establish coverage: create nodes for active areas first, expand coverage incrementally.'
      : 'Add to an existing node mapping, or create a new node.';
    coverageMd = {
      what: `${uncoveredFiles.length} source files have no graph coverage.\nExamples:\n${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining} more`,
      why: 'Files without graph coverage cannot be modified under the protocol.',
      next: `${guidance}\nCheck ownership candidates: yg context --file <path>`,
    };
  }

  return {
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    messageData: coverageMd,
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}

/** Build the non-blocking 'uncovered-advisory' warning for the middle tier. */
export function buildCoverageAdvisoryIssue(uncoveredFiles: string[]): CheckIssue | null {
  if (uncoveredFiles.length === 0) return null;
  const sample = uncoveredFiles.slice(0, 5);
  const remaining = uncoveredFiles.length - sample.length;
  const body = uncoveredFiles.length <= 5
    ? sample.map(f => '  ' + f).join('\n')
    : `${sample.map(f => '  ' + f).join('\n')}\n... and ${remaining} more`;
  return {
    severity: 'warning',
    code: 'uncovered-advisory',
    rule: 'uncovered-advisory',
    messageData: {
      what: `${uncoveredFiles.length} tracked file${uncoveredFiles.length === 1 ? '' : 's'} outside any required coverage root.\n${body}`,
      why: 'Not under a coverage.required root — visible but non-blocking. Bring an area under graph coverage to enforce it.',
      next: 'Map these files to a node, or add their root to coverage.required to make this an error.',
    },
    uncoveredFiles,
    uncoveredCount: uncoveredFiles.length,
  };
}
