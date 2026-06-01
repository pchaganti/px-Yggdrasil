import path from 'node:path';
import type { Graph } from '../../../src/model/graph.js';
import type { DriftNodeState, AspectVerdict } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { getChildMappingExclusions } from '../../../src/core/approve.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../../../src/core/graph/aspects.js';

/**
 * Commit an approve result, first filling the pending baseline's aspectVerdicts
 * with `approved` for every effective non-draft aspect — exactly what the
 * reviewer would record on a clean approve. Tests that drive approveNode +
 * commitApproval directly (bypassing the reviewer) use this so a follow-up
 * approve/check sees no aspect-newly-active drift.
 */
export async function commitApprovedBaseline(
  graph: Graph,
  nodePath: string,
  yggRoot: string,
  result: { pendingDriftState?: { nodePath: string; state: DriftNodeState } },
): Promise<void> {
  const node = graph.nodes.get(nodePath);
  if (result.pendingDriftState && node) {
    const statuses = computeEffectiveAspectStatuses(node, graph);
    const verdicts: Record<string, AspectVerdict> = { ...result.pendingDriftState.state.aspectVerdicts };
    for (const id of computeEffectiveAspects(node, graph)) {
      if (statuses.get(id) === 'draft') continue;
      verdicts[id] = { verdict: 'approved' };
    }
    result.pendingDriftState.state.aspectVerdicts = verdicts;
  }
  const { commitApproval } = await import('../../../src/core/approve.js');
  await commitApproval(yggRoot, result as Parameters<typeof commitApproval>[1]);
}

/**
 * Record a CONSISTENT typed baseline for every mapped node in the graph,
 * exactly as a successful approve would: the canonical hash folds the typed
 * identity, and every effective non-draft aspect carries an `approved` verdict
 * (so a follow-up approve/check sees no drift and no aspect-newly-active).
 *
 * Test-only helper. Mirrors the production approve write shape.
 */
export async function recordBaselineForAllMappedNodes(graph: Graph): Promise<void> {
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.mapping) continue;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const excl = getChildMappingExclusions(graph, nodePath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, excl, identity,
    );
    const statuses = computeEffectiveAspectStatuses(node, graph);
    const aspectVerdicts: Record<string, AspectVerdict> = {};
    for (const id of computeEffectiveAspects(node, graph)) {
      if (statuses.get(id) === 'draft') continue;
      aspectVerdicts[id] = { verdict: 'approved' };
    }
    const state: DriftNodeState = {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      identity,
      aspectVerdicts,
    };
    await writeNodeDriftState(graph.rootPath, nodePath, state);
  }
}
