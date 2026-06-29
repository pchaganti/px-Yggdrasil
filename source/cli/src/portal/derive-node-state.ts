import type { Graph, GraphNode } from '../model/graph.js';
import type { CheckIssue } from './engine-api.js';
import type {
  PortalNode,
  PortalState,
  PortalPairState,
  PortalEffectiveAspect,
  PortalSuppression,
} from './contract.js';
import type { SuppressionsByFile } from './derive-nodes.js';

/**
 * derive-node-state — the pure honest-state classification helpers split out of derive-nodes.
 *
 * These are pure functions over already-derived per-node facts (effective-aspect rows, the
 * node's check issues, the freshness flag, the in-memory built tree): the own-state rule, the
 * bottom-up roll-up, the not-applicable (when-filtered-out) set, and the per-node suppression
 * collection. No engine call, no lock read, no re-derivation of a verdict — they only RANK and
 * COMBINE states the pipeline already computed. Kept in their own focused file so derive-nodes
 * stays under the focused-file cap; the rank tables live here as the single source of truth.
 */

const PAIR_RANK: Record<PortalPairState, number> = {
  refused: 3,
  unverified: 2,
  verified: 1,
  'n/a': 0,
};

/** The worst (highest-rank) pair state across an aspect's units on a node. */
export function worstPairState(states: PortalPairState[]): PortalPairState {
  return states.reduce((worst, s) => (PAIR_RANK[s] > PAIR_RANK[worst] ? s : worst), 'verified');
}

const STATE_RANK: Record<PortalState, number> = {
  refused: 4,
  unverified: 3,
  warning: 2,
  verified: 1,
  'no-rule': 0,
};

/**
 * Own honest state. A node is `checked` ONLY when it has at least one real
 * verdict-bearing pair (an effective-aspect row with a non-`n/a` pair state); a node
 * with no such pair — including an empty-mapping container that merely inherits a
 * type-default aspect resolving to zero pairs — is `no-rule` (never green, nothing
 * actually checks it). A checked node otherwise reads the worst pair state across its
 * aspects, then promoted
 * to `warning` when a node-scoped advisory issue (e.g. high-fan-out) applies but
 * no pair is refused/unverified. An enforced error issue surfaces as `refused`
 * only when it is a code refusal pair; structural/coverage node issues that are
 * errors are reflected by the worklist, not the node's own pill, except advisory
 * warnings which promote a clean node to `warning`.
 *
 * The file-aware loop overrides last: when the node's source has CHANGED since its
 * last positive closure (`fresh`), its state is forced to at least `unverified` —
 * the touched bytes are "we don't know", so a no-rule node, a verified node, and a
 * warning node all read unverified after an edit. This is the honesty core: a
 * whole-repo cached green can never paint a file you just touched as a pass. A
 * `refused` pair still outranks (a known code "no" is stronger than "we don't know").
 */
export function computeOwnState(
  checked: boolean,
  effectiveAspects: PortalEffectiveAspect[],
  nodeIssues: CheckIssue[],
  fresh: boolean,
): PortalState {
  let worst: PortalState = checked ? 'verified' : 'no-rule';

  if (checked) {
    for (const ea of effectiveAspects) {
      if (ea.pairState === 'refused' && STATE_RANK['refused'] > STATE_RANK[worst]) worst = 'refused';
      else if (ea.pairState === 'unverified' && STATE_RANK['unverified'] > STATE_RANK[worst]) worst = 'unverified';
    }

    // A node-scoped warning issue (advisory) promotes an otherwise-clean node to
    // `warning`; it never downgrades a refused/unverified node.
    const hasWarning = nodeIssues.some((i) => i.severity === 'warning');
    if (hasWarning && STATE_RANK['warning'] > STATE_RANK[worst]) worst = 'warning';
  }

  // The file-aware loop: a touched file is "we don't know" — at least unverified,
  // applied even to a no-rule node that owns source. Refused (a known "no") outranks.
  if (fresh && STATE_RANK['unverified'] > STATE_RANK[worst]) worst = 'unverified';

  return worst;
}

/** Bottom-up roll-up: the worst of a node's own state and every child's roll-up. */
export function computeRollup(node: GraphNode, built: Map<string, PortalNode>): PortalState {
  let worst = built.get(node.path)!.state;
  for (const child of node.children) {
    const childRollup = built.get(child.path)?.rollupState ?? 'no-rule';
    if (STATE_RANK[childRollup] > STATE_RANK[worst]) worst = childRollup;
  }
  return worst;
}

/** Suppressions whose file is one of the node's mapped files. */
export function collectNodeSuppressions(
  mapping: string[],
  suppressions: SuppressionsByFile,
): PortalSuppression[] {
  const out: PortalSuppression[] = [];
  const owned = new Set(mapping);
  for (const file of owned) {
    const hits = suppressions.byFile.get(file);
    if (hits) out.push(...hits);
  }
  return out;
}

/**
 * notApplicable = aspects ATTACHED to the node (via any channel, ignoring `when`)
 * that are filtered OUT of the effective set by a `when` predicate. The status
 * walk (`getAspectStatusSources`) is `when`-filtered, so an attached-but-inactive
 * aspect appears in the raw attach scan yet not in the effective ids — that gap is
 * the not-applicable set.
 */
export function computeNotApplicable(
  node: GraphNode,
  graph: Graph,
  effectiveIds: Set<string>,
): Array<{ aspectId: string; why: string }> {
  const attachedIds = new Set<string>();
  // Channel 1: own; channel 3: own type; channels 2/4/5/6 reach via the same
  // status-source machinery when their `when` holds — but a when-filtered-out
  // attach yields NO status source, so to detect not-applicable we scan the raw
  // declared aspect ids (own + type defaults + flow + port) against the effective set.
  for (const id of node.meta.aspects ?? []) attachedIds.add(id);
  const typeDef = graph.architecture?.node_types?.[node.meta.type];
  for (const id of typeDef?.aspects ?? []) attachedIds.add(id);

  const out: Array<{ aspectId: string; why: string }> = [];
  for (const id of [...attachedIds].sort()) {
    if (effectiveIds.has(id)) continue;
    out.push({ aspectId: id, why: 'filtered out by a `when` predicate on this node' });
  }
  return out;
}
