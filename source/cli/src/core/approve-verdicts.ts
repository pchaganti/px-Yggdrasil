import type { Graph, GraphNode } from '../model/graph.js';
import type { ApproveResult, AspectVerdict, AspectVerificationResult } from '../model/drift.js';
import { computeEffectiveAspectStatuses } from './graph/aspects.js';

/**
 * Build per-aspect verdicts from reviewer results.
 *
 * Captures the verdict for every non-draft effective aspect that the reviewer
 * evaluated. Draft aspects are skipped — they were never dispatched. Aspects
 * absent from allAspectResults (e.g. when no reviewer ran) are also skipped.
 */
export function buildAspectVerdicts(
  node: GraphNode,
  graph: Graph,
  allAspectResults: Record<string, AspectVerificationResult>,
): { verdicts: Record<string, AspectVerdict>; carryForward: string[] } {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const verdicts: Record<string, AspectVerdict> = {};
  // Effective non-draft aspects that this run could NOT validly evaluate — an
  // infra error (provider/runner failure, unreadable reference) or no reviewer
  // result at all. Their prior baseline verdict must be carried forward rather
  // than dropped (see applyAspectVerdictsToResult), so a transient failure never
  // wipes a known-good verdict nor becomes a durable CI-blocking refusal.
  const carryForward: string[] = [];
  for (const [aspectId, status] of statuses) {
    if (status === 'draft') continue;
    const res = allAspectResults[aspectId];
    if (res === undefined) {
      // Effective non-draft aspect with no reviewer result this run.
      carryForward.push(aspectId);
    } else if (res.satisfied === false) {
      if (res.errorSource !== 'codeViolation') {
        // Infra error — not a code violation.
        carryForward.push(aspectId);
        continue;
      }
      verdicts[aspectId] = { verdict: 'refused', reason: res.reason, errorSource: res.errorSource };
    } else if (res.satisfied === true) {
      verdicts[aspectId] = { verdict: 'approved' };
    }
  }
  return { verdicts, carryForward };
}

/**
 * Detect a reviewer abort: the node has non-draft effective aspects but
 * `allAspectResults` is empty (no reviewer call landed any verdict — e.g.
 * tier-resolution failed before any aspect ran). On abort we must NOT
 * clobber prior `aspectVerdicts` in the baseline; the prior state remains
 * authoritative until a successful re-approve produces fresh verdicts.
 */
export function reviewerAborted(
  node: GraphNode,
  graph: Graph,
  allAspectResults: Record<string, AspectVerificationResult>,
): boolean {
  if (Object.keys(allAspectResults).length > 0) return false;
  const statuses = computeEffectiveAspectStatuses(node, graph);
  for (const s of statuses.values()) {
    if (s !== 'draft') return true;
  }
  return false;
}

/**
 * Merge new verdicts into result.pendingDriftState.
 *
 * When filterAspectId is set (per-aspect approve), only the targeted aspect's
 * verdict is updated — other aspects' prior verdicts are preserved from the
 * stored baseline. When unset (full-node approve), the new verdicts replace the
 * prior set, EXCEPT: (a) when the reviewer aborted before evaluating any aspect
 * (e.g. tier-resolution failure), all prior verdicts are preserved to avoid a
 * "nothing evaluated" wipe; (b) for each aspect in `carryForward` — effective
 * non-draft aspects that could not be validly evaluated this run (infra error or
 * missing result) — the prior verdict is carried forward. Without (b) a transient
 * provider/runner failure on one aspect of a full-node approve would wipe that
 * aspect's known-good baseline verdict, surfacing as aspect-newly-active (a
 * CI-blocking error) on the next check.
 *
 * No-op when result.pendingDriftState is undefined (some early-return paths
 * never set it; baseline simply isn't written, matching prior behavior).
 */
export function applyAspectVerdictsToResult(
  result: ApproveResult,
  verdicts: Record<string, AspectVerdict>,
  carryForward: string[],
  priorVerdicts: Record<string, AspectVerdict> | undefined,
  filterAspectId: string | undefined,
  aborted: boolean,
): void {
  if (!result.pendingDriftState) return;
  let merged: Record<string, AspectVerdict>;
  if (filterAspectId) {
    merged = { ...(priorVerdicts ?? {}), ...verdicts };
  } else if (aborted) {
    merged = { ...(priorVerdicts ?? {}) };
  } else {
    merged = { ...verdicts };
    for (const id of carryForward) {
      const prev = priorVerdicts?.[id];
      if (prev) merged[id] = prev;
    }
  }
  result.pendingDriftState.state.aspectVerdicts = merged;
}
