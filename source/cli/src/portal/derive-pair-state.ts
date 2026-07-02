import type { PortalPairState } from './contract.js';

/**
 * derive-pair-state — the single responsibility of ranking display PAIR states and reducing a
 * set of them to the worst one. Split out of derive-node-state so each derivation file stays a
 * focused child under the export cap; this is the rank table + the reducer that consume it.
 *
 * `warning` is the status-adjusted rendering of an advisory refusal: WORSE than a clean
 * `verified` (so a unit advisory-refusal promotes the node to warning) but never outranking a
 * real blocking `refused` or an `unverified`. This keeps an advisory refusal honest — signal,
 * not a blocking "no" — without ever letting it read as green.
 */
const PAIR_RANK: Record<PortalPairState, number> = {
  refused: 4,
  unverified: 3,
  warning: 2,
  verified: 1,
  'n/a': 0,
};

/** The worst (highest-rank) display pair state across an aspect's units on a node. */
export function worstPairState(states: PortalPairState[]): PortalPairState {
  return states.reduce((worst, s) => (PAIR_RANK[s] > PAIR_RANK[worst] ? s : worst), 'verified');
}
