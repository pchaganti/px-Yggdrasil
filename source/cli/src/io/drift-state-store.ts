import { readFile, stat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DriftState, DriftNodeState } from '../model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../model/drift.js';
import { debugWrite } from '../utils/debug-log.js';
import { atomicWriteFile } from '../io/atomic-write.js';
import { toPosix } from '../utils/posix.js';
import { buildIssueMessage } from '../formatters/message-builder.js';

const DRIFT_STATE_DIR = '.drift-state';

/**
 * Thrown when a baseline on disk lacks the current schemaVersion. Such a
 * baseline predates the typed drift-state format and must be re-keyed by the
 * migration (core/drift-state-rekey.ts via `yg init --upgrade`) — the
 * single-format runtime never parses an old baseline. This is the second net
 * behind the graph-loader version gate, scoped to baselines specifically.
 */
export class OutdatedDriftBaselineError extends Error {
  constructor(nodePath: string, found: unknown) {
    super(
      buildIssueMessage({
        what: `the drift-state baseline for node '${nodePath}' has schemaVersion ${JSON.stringify(found)}, not ${DRIFT_STATE_SCHEMA_VERSION}`,
        why: 'this CLI reads only the current typed baseline format; a baseline with an absent or unrecognized schemaVersion predates it and is upgraded by a migration, never parsed directly',
        next: 'run `yg init --upgrade` to migrate the .yggdrasil graph (including drift-state baselines) to the current format, then re-run',
      }),
    );
    this.name = 'OutdatedDriftBaselineError';
  }
}

/**
 * Validate the parsed baseline's schemaVersion and required shape at the
 * read boundary. Returns the value typed as DriftNodeState, or throws
 * OutdatedDriftBaselineError when the version is absent/unrecognized.
 */
function validateBaselineShape(nodePath: string, parsed: unknown): DriftNodeState {
  if (parsed === null || typeof parsed !== 'object') {
    throw new OutdatedDriftBaselineError(nodePath, undefined);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== DRIFT_STATE_SCHEMA_VERSION) {
    throw new OutdatedDriftBaselineError(nodePath, obj.schemaVersion);
  }
  // A schemaVersion-1 baseline MUST carry the required typed fields. A missing
  // field means the file was hand-corrupted (or written by buggy/foreign code);
  // reject it rather than letting runtime crash on undefined access. The
  // upgrade pointer is the recovery path (restore from git, or re-approve).
  const isRecord = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (
    typeof obj.hash !== 'string' ||
    !isRecord(obj.files) ||
    !isRecord(obj.identity) ||
    !isRecord(obj.aspectVerdicts)
  ) {
    throw new OutdatedDriftBaselineError(nodePath, obj.schemaVersion);
  }
  return parsed as DriftNodeState;
}

/** Convert node path to per-node state file path under .drift-state/ */
function nodeStatePath(yggRoot: string, nodePath: string): string {
  return path.join(yggRoot, DRIFT_STATE_DIR, `${nodePath}.json`);
}

/**
 * Recursively scan a directory for .json files.
 * Returns array of paths relative to baseDir (without .json extension).
 */
async function scanJsonFiles(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    debugWrite(`[drift-state-store] scanJsonFiles readdir: ${(err as Error).message}`);
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await scanJsonFiles(fullPath, baseDir);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const relPath = path.relative(baseDir, fullPath);
      // Remove .json extension and normalize to posix
      const nodePath = toPosix(relPath).replace(/\.json$/, '');
      results.push(nodePath);
    }
  }
  return results;
}

/**
 * Remove empty directories walking up from filePath to (but not including) stopDir.
 */
async function removeEmptyParents(filePath: string, stopDir: string): Promise<void> {
  let dir = path.dirname(filePath);
  while (dir !== stopDir && dir.startsWith(stopDir)) {
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) {
        await rm(dir, { recursive: true });
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch (err) {
      debugWrite(`[drift-state-store] removeEmptyParents: ${(err as Error).message}`);
      break;
    }
  }
}

/**
 * Read a single node's drift state from .drift-state/<nodePath>.json.
 *
 * A missing or unparseable file reads as `undefined` (cold start / graceful
 * skip of corrupt JSON). A file that parses but lacks the current
 * schemaVersion is an OLD baseline — that throws OutdatedDriftBaselineError so
 * the runtime never silently treats a stale baseline as a cold start (which
 * would go green over unverified code). Version validation runs OUTSIDE the
 * parse try so the upgrade-pointing error propagates rather than being
 * swallowed as a corrupt-file skip.
 */
export async function readNodeDriftState(
  yggRoot: string,
  nodePath: string,
): Promise<DriftNodeState | undefined> {
  let parsed: unknown;
  try {
    const filePath = nodeStatePath(yggRoot, nodePath);
    const content = await readFile(filePath, 'utf-8');
    parsed = JSON.parse(content);
  } catch (err) {
    debugWrite(`[drift-state-store] readNodeDriftState: ${(err as Error).message}`);
    return undefined;
  }
  return validateBaselineShape(nodePath, parsed);
}

/** Write a single node's drift state to .drift-state/<nodePath>.json */
export async function writeNodeDriftState(
  yggRoot: string,
  nodePath: string,
  nodeState: DriftNodeState,
): Promise<void> {
  const filePath = nodeStatePath(yggRoot, nodePath);
  // Stamp the current schemaVersion on every write so producers cannot emit an
  // unversioned baseline (the read store rejects those). schemaVersion is
  // serialized first for readability.
  const stamped: DriftNodeState = { ...nodeState, schemaVersion: DRIFT_STATE_SCHEMA_VERSION };
  const content = JSON.stringify(stamped, null, 2) + '\n';
  await atomicWriteFile(filePath, content);
}

/**
 * Remove specified aspect IDs from the per-node drift baseline's aspectVerdicts.
 *
 * Used after a successful approve to evict stale verdicts for aspects that
 * have transitioned to `draft` status — draft aspects are dormant (no reviewer
 * call, no baseline maintenance), so any leftover verdict from a prior approve
 * must be cleared to keep the baseline consistent with what the reviewer
 * actually evaluated.
 *
 * No-op when the node has no stored state or when none of the requested IDs
 * are present. aspectVerdicts is required (may be `{}`) — when removal empties
 * it, the empty map is retained, not dropped.
 *
 * For deterministic aspects, `identity.aspects[id].checkTouched` is NOT
 * cleared here — it is preserved across draft toggle so the next non-draft
 * approve can compare against the previous baseline.
 */
export async function clearDraftAspectsFromDriftState(
  yggRoot: string,
  nodePath: string,
  aspectIdsToClear: Set<string>,
): Promise<void> {
  const state = await readNodeDriftState(yggRoot, nodePath);
  if (!state) return;
  let mutated = false;
  for (const id of aspectIdsToClear) {
    if (id in state.aspectVerdicts) {
      delete state.aspectVerdicts[id];
      mutated = true;
    }
  }
  if (!mutated) return;
  await writeNodeDriftState(yggRoot, nodePath, state);
}

/**
 * Garbage-collect drift state: remove .json files for node paths NOT in validNodePaths,
 * or for which shouldKeep returns false.
 * Cleans up empty parent directories after removal.
 * Returns sorted list of removed node paths.
 */
export async function garbageCollectDriftState(
  yggRoot: string,
  validNodePaths: Set<string>,
  shouldKeep?: (nodePath: string) => boolean,
): Promise<string[]> {
  const driftDir = path.join(yggRoot, DRIFT_STATE_DIR);
  const allNodePaths = await scanJsonFiles(driftDir, driftDir);
  const removed: string[] = [];

  for (const nodePath of allNodePaths) {
    const inGraph = validNodePaths.has(nodePath);
    const keep = inGraph && (shouldKeep ? shouldKeep(nodePath) : true);
    if (!keep) {
      const filePath = nodeStatePath(yggRoot, nodePath);
      await rm(filePath);
      await removeEmptyParents(filePath, driftDir);
      removed.push(nodePath);
    }
  }

  return removed.sort();
}

/**
 * Read full drift state.
 * - If .drift-state is a directory: scan for per-node .json files.
 * - If .drift-state doesn't exist: return {}.
 */
export async function readDriftState(yggRoot: string): Promise<DriftState> {
  const driftPath = path.join(yggRoot, DRIFT_STATE_DIR);

  let driftStat;
  try {
    driftStat = await stat(driftPath);
  } catch (err) {
    debugWrite(`[drift-state-store] readDriftState stat: ${(err as Error).message}`);
    return {};
  }

  // .drift-state must be a directory; if it's a file, ignore it
  if (driftStat.isFile()) {
    debugWrite(`[drift-state-store] readDriftState: .drift-state is a file, expected directory — returning empty`);
    return {};
  }

  // Scan for per-node .json files
  const nodePaths = await scanJsonFiles(driftPath, driftPath);
  const state: DriftState = {};
  for (const nodePath of nodePaths) {
    const nodeState = await readNodeDriftState(yggRoot, nodePath);
    if (nodeState) {
      state[nodePath] = nodeState;
    }
  }
  return state;
}

/**
 * Write full drift state as per-node files.
 * Each entry is written as a separate .json file under .drift-state/.
 */
export async function writeDriftState(yggRoot: string, state: DriftState): Promise<void> {
  for (const [nodePath, nodeState] of Object.entries(state)) {
    await writeNodeDriftState(yggRoot, nodePath, nodeState);
  }
}
