/**
 * source/cli/src/core/fill-log-gate.ts — the per-node mandatory-log gate for the
 * fill stage (spec §9).
 *
 * logGateBlocksNode is the SINGLE source of truth for the freshness/fingerprint
 * rule. The fill step-4 gate (logGateBlocks) and positive closure both consult
 * it, so a node closure can never advance a fingerprint the gate would have
 * blocked.
 */

import type { Graph, GraphNode } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { computeSourceFingerprint, FileUnreadableError } from './pairs.js';
import { hasFreshLogEntry, readLogContent } from './log/log-gate.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * True when a node is blocked by the mandatory-log gate (spec §9): the type opts
 * into log_required (default false) AND the current source fingerprint differs
 * from the stored one (or none is stored and the mapping is non-empty — first
 * verification) AND no fresh log entry exists.
 *
 * This is the SINGLE source of truth for the freshness/fingerprint rule. The
 * fill step-4 gate (logGateBlocks) and positive closure both consult it, so a
 * node closure can never advance a fingerprint the gate would have blocked
 * (defects 1, 2, 4: a node that never entered the run's nodeSet — e.g. its
 * source change touched only scope/binary-excluded files, leaving zero
 * unverified pairs — was never passed through step 4, so closure must re-check
 * the gate itself rather than trust step-4's blocked set alone).
 */
export async function logGateBlocksNode(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
): Promise<boolean> {
  // The default lives HERE and only here (spec §9): false unless the type opts in.
  const archType = graph.architecture.node_types[node.meta.type];
  const logRequired = archType?.log_required ?? false;
  if (!logRequired) return false;

  let currentFingerprint: string | undefined;
  try {
    currentFingerprint = await computeSourceFingerprint(graph, node.path);
  } catch (e) {
    // An unreadable mapped file makes the fingerprint uncomputable. The node is
    // already surfaced as a blocking file-unreadable error; block it here too so
    // its pairs are never filled/closed over an unreadable source.
    if (e instanceof FileUnreadableError) {
      debugWrite(`[fill] logGate fingerprint for ${toPosixPath(node.path)}: ${e.message}`);
      return true;
    }
    throw e;
  }
  // A mapping-less node has a constant (undefined) fingerprint — the gate never
  // fires for it (§9). A node with a non-empty mapping but no stored fingerprint
  // is a first verification (drifted = true).
  if (currentFingerprint === undefined) return false;
  const storedFingerprint = lock.nodes[node.path]?.source;
  const drifted = currentFingerprint !== storedFingerprint;
  if (!drifted) return false;

  const logContent = await readLogContent(projectRoot, node.path);
  return !hasFreshLogEntry(logContent, lock.nodes[node.path]?.log);
}

/**
 * Step-4 log gate: like logGateBlocksNode, but emits the `log-entry-missing`
 * message when it blocks (its pairs are skipped this run; other nodes proceed).
 */
export async function logGateBlocks(
  graph: Graph,
  projectRoot: string,
  node: GraphNode,
  lock: LockFile,
  emitIssue: (msg: IssueMessage) => void,
): Promise<boolean> {
  const blocked = await logGateBlocksNode(graph, projectRoot, node, lock);
  if (!blocked) return false;

  emitIssue({
    what: `No fresh log entry for node '${toPosixPath(node.path)}' — mandatory before --approve when source changed.`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change needs a justification entry capturing WHY. This node's pairs are skipped this run; other nodes proceed.`,
    next: `yg log add --node ${toPosixPath(node.path)} --reason '<justification>', then re-run: yg check --approve`,
  });
  return true;
}
