import type { CheckIssue, CascadeCause } from './check.js';
import type { Graph } from '../model/graph.js';
import type { ApproveResult, DriftNodeState } from '../model/drift.js';
import { collectParticipatingFlows } from './graph/flows.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
import { tierIdentityKey, checkTouchedKey, aspectMetaKey } from './graph/files.js';
import { readNodeDriftState } from '../io/drift-state-store.js';
import { toPosix } from '../utils/posix.js';

/**
 * Cascade-node / cascade-aspect selection for batch approve (`--node` cascade,
 * `--flow`, `--aspect`). Pure graph/string logic extracted out of the command
 * wrapper so it is unit-tested AND counted toward coverage (the `cli/**` glue is
 * excluded from coverage; this logic is not glue).
 */

/**
 * Select nodes for a cause-prefix cascade (e.g. `--aspect` via its `aspects/<id>/`
 * prefix): nodes with upstream drift whose cascade cause file starts with the prefix.
 */
export function filterCascadeNodes(
  issues: CheckIssue[],
  causePrefix: string,
): string[] {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath || !issue.cascadeCauses) continue;
    const hasMatchingCause = issue.cascadeCauses.some(
      (c: CascadeCause) => toPosix(c.file).startsWith(causePrefix),
    );
    if (hasMatchingCause) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
}

/**
 * Select nodes for `yg approve --flow <name>`: nodes that have cascade
 * (upstream) drift AND participate in the flow. Unlike `filterCascadeNodes`,
 * this does NOT match on a cause-file prefix — a flow-attached aspect's change
 * is recorded under `aspects/<id>/`, never `flows/<name>/`, so a path-prefix
 * filter misses every participant. Flow participation follows the
 * descendant-inclusion rule via `collectParticipatingFlows` (a node
 * participates when it or any ancestor is a declared participant).
 */
export function filterFlowCascadeNodes(
  issues: CheckIssue[],
  graph: Graph,
  flowName: string,
): string[] {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath) continue;
    const node = graph.nodes.get(issue.nodePath);
    if (!node) continue;
    if (collectParticipatingFlows(graph, node).some(f => f.path === flowName)) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
}

/**
 * Single source of truth for the drift-cause paths attributable to one aspect:
 * its `aspects/<id>/` prefix plus the synthetic identity keys and reference-file
 * paths that `collectTrackedFiles` emits for it. The synthetic keys come from the
 * key-builders in core/graph/files.js (the producers), so this stays in lockstep
 * with how the keys are written into baselines. Both cascade-attribution helpers
 * below (filterAspectCascadeNodes, selectDriftedAspects) match a cause path with
 * `file.startsWith(prefix) || keys.has(file)`.
 *
 * When given the node's `checkTouchedFiles` (the baseline's per-aspect map of
 * actual cross-node paths a graph-aware deterministic aspect read), the keys also
 * include those raw paths for this aspect. A change to one of them then resolves to
 * the owning deterministic aspect instead of being un-attributable and forcing a
 * node-global re-run. Omit the argument to keep the synthetic-key-only behavior.
 */
function aspectDependencyKeys(
  aspectId: string,
  yggPrefix: string,
  graph: Graph,
  checkTouchedFiles?: Record<string, Record<string, string>>,
): { prefix: string; keys: Set<string> } {
  const aspect = graph.aspects.find(a => a.id === aspectId);
  const touched = checkTouchedFiles?.[aspectId];
  return {
    prefix: `${yggPrefix}/aspects/${aspectId}/`,
    keys: new Set<string>([
      tierIdentityKey(aspectId),
      checkTouchedKey(aspectId),
      aspectMetaKey(aspectId),
      ...(aspect?.references ?? []).map(r => toPosix(r.path)),
      ...(touched ? Object.keys(touched).map(p => toPosix(p)) : []),
    ]),
  };
}

/**
 * Select nodes for `yg approve --aspect <id>`: nodes with cascade drift caused
 * by this aspect. Not every cause for an aspect lives under `aspects/<id>/` — an
 * aspect's reference files and the synthetic per-aspect identity keys also count
 * (see aspectDependencyKeys). Match the prefix OR any of those.
 */
export async function filterAspectCascadeNodes(
  issues: CheckIssue[],
  graph: Graph,
  aspectId: string,
  yggPrefix: string,
): Promise<string[]> {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath || !issue.cascadeCauses) continue;
    // Attribute cross-node check-touched paths by consulting THIS node's stored
    // baseline: the raw file path a graph-aware deterministic aspect read (not a
    // synthetic key) only resolves to its owning aspect via the baseline's
    // per-aspect checkTouchedFiles map. A missing or corrupt baseline reads as
    // undefined → fall back to the synthetic-key / prefix match only.
    const storedEntry = await readNodeDriftState(graph.rootPath, issue.nodePath);
    const { prefix, keys } = aspectDependencyKeys(
      aspectId,
      yggPrefix,
      graph,
      storedEntry?.checkTouchedFiles,
    );
    const hit = issue.cascadeCauses.some((c: CascadeCause) => {
      const f = toPosix(c.file);
      return f.startsWith(prefix) || keys.has(f);
    });
    if (hit) matched.push(issue.nodePath);
  }
  return matched;
}

/**
 * Option 1: choose which effective non-draft aspects must be re-verified on an
 * approve where filterAspectId is undefined (--node, --flow cascade, parent-redirect).
 * Returns the subset of aspect ids to re-run, or `undefined` to re-run ALL
 * (node-global drift, or back-compat baseline without per-aspect verdicts).
 * Conservative: any source change, or any upstream change not attributable to a
 * specific aspect, forces a full re-run.
 */
export function selectDriftedAspects(
  graph: Graph,
  nodePath: string,
  result: ApproveResult,
  storedEntry: DriftNodeState | undefined,
  yggPrefix: string,
): Set<string> | undefined {
  if (!storedEntry?.aspectVerdicts) return undefined;
  if (result.changedSource && result.changedSource.length > 0) return undefined;

  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;
  const effective = computeEffectiveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);

  const subset = new Set<string>();
  for (const change of result.changedUpstream ?? []) {
    const file = toPosix(change.filePath);
    const owners: string[] = [];
    for (const id of effective) {
      if (statuses.get(id) === 'draft') continue;
      const { prefix, keys } = aspectDependencyKeys(id, yggPrefix, graph, storedEntry.checkTouchedFiles);
      if (file.startsWith(prefix) || keys.has(file)) owners.push(id);
    }
    if (owners.length === 0) return undefined; // un-attributable upstream → node-global
    for (const id of owners) subset.add(id);
  }

  // Always re-run newly-attached aspects (effective + non-draft, no prior verdict
  // to carry forward — carry-forward only restores when a prior exists).
  for (const id of effective) {
    if (statuses.get(id) === 'draft') continue;
    if (!storedEntry.aspectVerdicts[id]) subset.add(id);
  }
  return subset;
}
