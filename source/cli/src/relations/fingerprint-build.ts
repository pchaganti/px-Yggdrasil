/**
 * Shared, deterministic constructions for relation-conformance fingerprints.
 *
 * Both the parse-heavy pass (`relations/pass.ts`, run under `--approve`) and the
 * parse-free re-validation (`relations/verify.ts`, run under plain `yg check`)
 * must build the EXACT same `FingerprintInput` for an unchanged tree, or a
 * freshly-sealed verdict would read back as unverified. To guarantee the two
 * sides cannot drift, every construction that feeds the fingerprint lives here
 * and is imported by both — there is one source of truth, never two copies.
 */
import type { Relation } from '../model/graph.js';
import { codePointCanonicalJson } from '../core/pair-hash.js';
import { hashString } from '../io/hash.js';

/**
 * Canonical comparator for [path, hash] pairs: by path, tie-break by hash.
 * Matches `cmpPair` folded into `computeFingerprint`, so the STORED evidence
 * order equals the order the hash is computed over.
 */
export function cmpFileHashPair(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** Sort a copy of a [path, hash] pair list canonically. */
export function sortFileHashPairs(pairs: Array<[string, string]>): Array<[string, string]> {
  return [...pairs].sort(cmpFileHashPair);
}

/**
 * Index identity over the symbol-language source set: hash of the canonical JSON
 * of the sorted (file, hash) pairs. The universe is every extractor-backed source
 * file in the graph — pass.ts and verify.ts must select the SAME set, so the
 * caller is responsible for handing in exactly that set (extractor-backed files).
 */
export function computeIndexIdentity(symbolSources: Array<[string, string]>): string {
  return hashString(codePointCanonicalJson(sortFileHashPairs(symbolSources)));
}

/** Hash a node's declared relations (the `relations` fingerprint field). */
export function hashRelations(relations: Relation[] | undefined): string {
  return hashString(codePointCanonicalJson(relations ?? []));
}

/**
 * The ancestor chain of a node id, nearest parent first. A node id is a
 * `/`-separated model-relative path; the chain is every strict prefix.
 */
export function parentChainOf(nodeId: string): string[] {
  const chain: string[] = [];
  let cur = nodeId;
  while (cur.includes('/')) {
    cur = cur.slice(0, cur.lastIndexOf('/'));
    chain.push(cur);
  }
  return chain;
}

/**
 * Basis = the declared target that sanctioned a resolved dependency.
 *   - the owner itself when the node declares a relation to it, else
 *   - the nearest ancestor of the owner the node declares a relation to, else
 *   - 'none' (an undeclared cross-node dependency).
 * Folded into the fingerprint, so pass.ts and verify.ts MUST agree byte-for-byte.
 */
export function computeBasis(declaredTargets: Set<string>, ownerNode: string): string {
  if (declaredTargets.has(ownerNode)) return ownerNode;
  const sanctioningAncestor = parentChainOf(ownerNode).find((anc) => declaredTargets.has(anc));
  return sanctioningAncestor ?? 'none';
}
