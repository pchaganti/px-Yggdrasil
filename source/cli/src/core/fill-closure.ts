/**
 * source/cli/src/core/fill-closure.ts — positive closure for the fill stage
 * (spec §7 step 5 / §9). After all fills, advances each node's source fingerprint
 * + log baseline IFF every enforced effective pair is FRESHLY verified-approved
 * this run (a single post-fill verifyLock pass is the only source of truth — never
 * the raw stored verdict token).
 */

import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { computeSourceFingerprint, FileUnreadableError } from './pairs.js';
import { verifyLock } from './verify-lock.js';
import { computeLogBaselineForNode } from './log/log-gate.js';
import { debugWrite } from '../utils/debug-log.js';
import { logGateBlocksNode } from './fill-log-gate.js';

/**
 * Positive closure (spec §7 step 5 / §9). For every node with a missing/stale
 * source fingerprint, advance its fingerprint + log baseline IFF, AT THE END OF
 * THIS RUN, ALL of the following hold:
 *
 *   (a) the node was NOT log-gate-blocked this run (blockedNodes), AND
 *   (b) the node is not blocked by the mandatory-log gate when re-checked here —
 *       this catches a drifted log_required node that never entered the run's
 *       nodeSet (its source change touched only scope/binary-excluded files, so
 *       it produced zero unverified pairs and step 4 never saw it), AND a drifted
 *       log_required node with ZERO enforced pairs (which must NOT vacuously
 *       close without a fresh entry), AND
 *   (c) every ENFORCED effective pair of the node is approved AGAINST CURRENT
 *       INPUTS — i.e. its post-fill verifyLock state is `verified` (a valid entry
 *       carrying an approved token). A pair that is merely stored-`approved` but
 *       is currently `unverified` (inputs changed, not re-verified this run),
 *       `refused`, or `prompt-too-large` does NOT count.
 *
 * INVARIANT: the closure decision NEVER reads lock.verdicts[...].verdict
 * directly. Fresh validity is sourced from a single post-fill verifyLock pass —
 * the authoritative per-pair classification for THIS run — so a stale-but-stored
 * approved token can never advance a fingerprint over code the run did not
 * actually verify (false-green of both the verdict and the §9 log gate).
 *
 * Advisory refusals never block closure (they are not enforced pairs). A node
 * with no enforced pairs at all closes vacuously ONLY when (a)+(b) also hold —
 * for a drifted log_required node that means a fresh log entry is required.
 * Mapping-less nodes have no source fingerprint; their log baseline is still
 * recorded at closure if a log.md exists (spec §9).
 */
export async function applyPositiveClosure(
  graph: Graph,
  projectRoot: string,
  lock: LockFile,
  blockedNodes: Set<string>,
  persistLock: () => Promise<void>,
): Promise<void> {
  // Single post-fill verification pass: the authoritative per-pair validity for
  // THIS run, computed against the freshly-written lock. This is the ONLY source
  // of truth for closure — never the raw stored verdict token.
  const verification = await verifyLock(graph, lock);
  const byNode = new Map<string, typeof verification.pairs>();
  for (const vp of verification.pairs) {
    const list = byNode.get(vp.pair.nodePath) ?? [];
    list.push(vp);
    byNode.set(vp.pair.nodePath, list);
  }

  let mutated = false;
  for (const [nodePath, node] of graph.nodes) {
    let currentFingerprint: string | undefined;
    try {
      currentFingerprint = await computeSourceFingerprint(graph, nodePath);
    } catch (e) {
      // An unreadable mapped file makes the fingerprint uncomputable. The node is
      // a blocking file-unreadable error this run — never close over it (advancing
      // the fingerprint/log baseline here would be a stale-green of the §9 gate).
      if (e instanceof FileUnreadableError) {
        debugWrite(`[fill] closure fingerprint for ${nodePath}: ${e.message}`);
        continue;
      }
      throw e;
    }
    if (currentFingerprint === undefined) {
      // Mapping-less node: no source fingerprint to record. Its log baseline is
      // still recorded at closure if a log.md exists (spec §9).
      await closeLogBaselineOnly(projectRoot, nodePath, lock);
      mutated = true;
      continue;
    }
    const stored = lock.nodes[nodePath]?.source;
    if (currentFingerprint === stored) continue; // fingerprint current — nothing to close

    // (a) A node whose pairs were skipped by the step-4 log gate this run must
    // never close over its stale verdicts.
    if (blockedNodes.has(nodePath)) continue;

    // (b) Re-check the mandatory-log gate here. This independently blocks a
    // drifted log_required node that step 4 never saw (zero unverified pairs) and
    // a drifted log_required node with zero enforced pairs (no vacuous close).
    if (await logGateBlocksNode(graph, projectRoot, node, lock)) continue;

    // (c) Every ENFORCED effective pair must be FRESHLY verified-approved this
    // run (state.kind === 'verified'); stored-approved-but-unverified does NOT
    // count. Advisory refusals are not enforced pairs and never block closure.
    const nodePairs = byNode.get(nodePath) ?? [];
    const allEnforcedApproved = nodePairs
      .filter((vp) => vp.pair.status === 'enforced')
      .every((vp) => vp.state.kind === 'verified');
    if (!allEnforcedApproved) continue; // a red/unverified enforced pair keeps the cycle open

    const entry = lock.nodes[nodePath] ?? {};
    entry.source = currentFingerprint;
    const logBaseline = await computeLogBaselineForNode(projectRoot, nodePath);
    if (logBaseline) entry.log = logBaseline;
    lock.nodes[nodePath] = entry;
    mutated = true;
  }
  if (mutated) await persistLock();
}

/** Record only the log baseline for a mapping-less node (spec §9). */
async function closeLogBaselineOnly(projectRoot: string, nodePath: string, lock: LockFile): Promise<void> {
  const logBaseline = await computeLogBaselineForNode(projectRoot, nodePath);
  if (!logBaseline) return;
  const entry = lock.nodes[nodePath] ?? {};
  entry.log = logBaseline;
  lock.nodes[nodePath] = entry;
}
