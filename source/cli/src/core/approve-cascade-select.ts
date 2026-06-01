import type { CheckIssue, CascadeCause } from './check.js';
import type { Graph } from '../model/graph.js';
import type { ApproveResult, DriftNodeState } from '../model/drift.js';
import { collectParticipatingFlows } from './graph/flows.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './graph/aspects.js';
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
 * Decide whether a single cascade cause is attributable to one aspect. A cause
 * attributes to aspect `id` when ANY of:
 *   - it is a typed identity change for that aspect (aspectMeta/tier/checkTouchedSet);
 *   - it is a real file under `aspects/<id>/` (the aspect's artifacts);
 *   - it is a real file matching one of the aspect's `references:` paths;
 *   - it is a cross-node check-touched real file whose attributed owner set
 *     (set by classifyDrift from the stored typed identity) includes this aspect.
 * This is the typed replacement for the former synthetic-key string matching;
 * it consults only the cause's own typed fields — no baseline re-read.
 */
function causeAttributesToAspect(
  cause: CascadeCause,
  aspectId: string,
  prefix: string,
  refPaths: Set<string>,
): boolean {
  if (cause.identity) {
    const c = cause.identity;
    return (c.kind === 'aspectMeta' || c.kind === 'tier' || c.kind === 'checkTouchedSet')
      && c.aspectId === aspectId;
  }
  if (cause.attributedAspectIds?.includes(aspectId)) return true;
  const f = toPosix(cause.file);
  return f.startsWith(prefix) || refPaths.has(f);
}

/** The `aspects/<id>/` prefix + the aspect's reference paths, for real-file matching. */
function aspectFilePrefixAndRefs(
  aspectId: string,
  yggPrefix: string,
  graph: Graph,
): { prefix: string; refPaths: Set<string> } {
  const aspect = graph.aspects.find(a => a.id === aspectId);
  return {
    prefix: `${yggPrefix}/aspects/${aspectId}/`,
    refPaths: new Set<string>((aspect?.references ?? []).map(r => toPosix(r.path))),
  };
}

/**
 * Select nodes for `yg approve --aspect <id>`: nodes with cascade drift caused
 * by this aspect. Attribution is typed (causeAttributesToAspect) — identity
 * causes carry their owning aspect id, real-file causes match the aspect's
 * artifact prefix / reference paths / attributed check-touched owners. No
 * baseline re-read is needed.
 */
export function filterAspectCascadeNodes(
  issues: CheckIssue[],
  graph: Graph,
  aspectId: string,
  yggPrefix: string,
): string[] {
  const matched: string[] = [];
  const { prefix, refPaths } = aspectFilePrefixAndRefs(aspectId, yggPrefix, graph);
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath || !issue.cascadeCauses) continue;
    const hit = issue.cascadeCauses.some((c: CascadeCause) =>
      causeAttributesToAspect(c, aspectId, prefix, refPaths));
    if (hit) matched.push(issue.nodePath);
  }
  return matched;
}

/**
 * Option 1: choose which effective non-draft aspects must be re-verified on an
 * approve where filterAspectId is undefined (--node, --flow cascade, parent-redirect).
 * Returns the subset of aspect ids to re-run, or `undefined` to re-run ALL
 * (node-global drift). Conservative: any source change, or any upstream change
 * not attributable to a specific aspect, forces a full re-run.
 */
export function selectDriftedAspects(
  graph: Graph,
  nodePath: string,
  result: ApproveResult,
  storedEntry: DriftNodeState | undefined,
  yggPrefix: string,
): Set<string> | undefined {
  if (!storedEntry) return undefined;
  if (result.changedSource && result.changedSource.length > 0) return undefined;

  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;
  const effective = computeEffectiveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);

  // Precompute each non-draft aspect's file prefix + reference paths once.
  const prefixByAspect = new Map<string, { prefix: string; refPaths: Set<string> }>();
  for (const id of effective) {
    if (statuses.get(id) === 'draft') continue;
    prefixByAspect.set(id, aspectFilePrefixAndRefs(id, yggPrefix, graph));
  }

  const subset = new Set<string>();
  for (const change of result.changedUpstream ?? []) {
    const cause: CascadeCause = {
      file: change.filePath,
      // layer is unused by causeAttributesToAspect; a placeholder keeps the type.
      layer: 'aspects',
      description: '',
      identity: change.identity,
      attributedAspectIds: change.attributedAspectIds,
    };
    const owners: string[] = [];
    for (const [id, { prefix, refPaths }] of prefixByAspect) {
      if (causeAttributesToAspect(cause, id, prefix, refPaths)) owners.push(id);
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
