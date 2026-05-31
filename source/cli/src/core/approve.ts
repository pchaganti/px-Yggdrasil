import type { Graph, GraphNode } from '../model/graph.js';
import type {
  ApproveResult,
  AnnotatedChange,
  TrackedFileLayer,
} from '../model/drift.js';
import {
  readNodeDriftState,
  writeNodeDriftState,
  garbageCollectDriftState,
} from '../io/drift-state-store.js';
import { hashTrackedFiles } from '../io/hash.js';
import { collectTrackedFiles, buildLayerResolver, yggPrefixOf } from './graph/files.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses, hasNonDraftEffectiveAspects } from './graph/aspects.js';
import { readTextFile, lstatFile } from '../io/graph-fs.js';
import { createHash } from 'node:crypto';
import { debugWrite } from '../utils/debug-log.js';
import path from 'node:path';
import { parseLog } from './parsing/log-parser.js';
import { validateFormat } from './log-format.js';
import { validateAppendOnly } from './log-integrity.js';
import type { IssueMessage } from '../model/validation.js';
import { toPosixPath } from '../utils/posix.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ApproveOptions {
}

/**
 * Approve a node's current state, recording it as the new baseline.
 * Binary model: any source or upstream change triggers approval.
 */
export async function approveNode(
  graph: Graph,
  nodePath: string,
  _options: ApproveOptions = {},
): Promise<ApproveResult> {
  // Validate node exists
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node '${nodePath}' does not exist.`);

  const mappingPaths = normalizeMappingPaths(node.meta.mapping);

  // ── Log snapshot (shared by all paths) ──────────────────
  let logSnapshot: LogSnapshot;
  try {
    logSnapshot = await snapshotLog(graph.rootPath, nodePath);
  } catch (err) {
    const msg = (err as Error).message;
    debugWrite(`[approve] snapshotLog error for node ${nodePath}: ${msg}`);
    const logRel = `.yggdrasil/model/${nodePath}/log.md`;
    let refuseReasonMd: IssueMessage;
    if (msg.includes('symlink')) {
      refuseReasonMd = {
        what: `${logRel} is a symbolic link`,
        why: 'Symlinks bypass append-only guarantees and break integrity hashing.',
        next: 'Remove the symlink and let yg log add create a regular file.',
      };
    } else if (msg.includes('hardlinks') || msg.includes('nlink')) {
      refuseReasonMd = {
        what: `${logRel} has multiple hard links`,
        why: 'Hard links would orphan integrity baselines on atomic rename.',
        next: 'Copy to a unique file and replace the hard link.',
      };
    } else {
      /* v8 ignore next */
      refuseReasonMd = { what: msg, why: 'Unexpected error reading log.md.', next: 'Check file permissions and restore from git if needed.' };
    }
    return { action: 'refused', currentHash: '', refuseReasonData: refuseReasonMd };
  }

  const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);

  // ── Integrity check (runs even when log.md missing if baseline exists) ──
  if (storedEntry?.log) {
    const check = validateAppendOnly(
      logSnapshot.content,
      storedEntry.log.last_entry_datetime,
      storedEntry.log.prefix_hash,
    );
    if (!check.ok) {
      const logRel = `.yggdrasil/model/${nodePath}/log.md`;
      const logIntegrityMd: IssueMessage = {
        what: `Log integrity broken (${check.reason}) at ${logRel}${logSnapshot.existed ? '' : ' (file missing)'}`,
        why: check.reason === 'prefix_modified'
          ? 'Historical (pre-baseline) log content was modified — append-only violated.'
          : 'Baseline boundary entry not found — log deleted or reset.',
        next: `Restore from git: git checkout HEAD -- ${logRel} .yggdrasil/.drift-state/${nodePath}.json`,
      };
      return {
        action: 'refused',
        currentHash: '',
        refuseReasonData: logIntegrityMd,
      };
    }
  }

  // ── Format check ────────────────────────────────────────
  if (logSnapshot.existed) {
    const violations = validateFormat(logSnapshot.content);
    if (violations.length > 0) {
      const logRel = `.yggdrasil/model/${nodePath}/log.md`;
      const zone = classifyViolationZone(violations, logSnapshot.content, storedEntry?.log?.last_entry_datetime);
      const next = zone === 'pre-baseline'
        ? `Pre-baseline violation (in hashed history). Restore from git: git checkout HEAD -- ${logRel} .yggdrasil/.drift-state/${nodePath}.json`
        : `Post-baseline violation (editable). Edit ${logRel} manually to remove the offending line(s), then re-run approve.`;
      const logFormatMd: IssueMessage = {
        what: `Log format invalid at ${logRel}:\n${violations.map((v) => `  line ${v.line}: ${v.reason} — ${v.detail}`).join('\n')}`,
        why: 'Log format must be parseable for integrity + indexing.',
        next,
      };
      return {
        action: 'refused',
        currentHash: '',
        refuseReasonData: logFormatMd,
      };
    }
  }

  const logRequired = logRequiredFor(node, graph);

  // ── Logical node (no mapping) — log-only path ───────────
  if (mappingPaths.length === 0) {
    // Honor the node type's log_required flag: only a log_required type's
    // mapping-less node demands a log.md entry. When log_required is false a
    // mapping-less node has nothing to track — it is a clean no-op.
    if (!logSnapshot.existed) {
      if (!logRequired) {
        const gcPaths = await runGC(graph);
        return { action: storedEntry ? 'no-change' : 'initial', currentHash: '', previousHash: storedEntry?.hash, gcPaths };
      }
      const noLogMd: IssueMessage = {
        what: `Node '${nodePath}' has no mapping and no log.md — nothing to approve`,
        why: 'Nodes without source mapping participate in the log system only. A log.md entry is required.',
        next: `yg log add --node ${nodePath} --reason '<justification>'`,
      };
      return {
        action: 'refused',
        currentHash: '',
        refuseReasonData: noLogMd,
      };
    }
    const gcPaths = await runGC(graph);
    const baseline = computeLogBaseline(logSnapshot.content);
    const action: ApproveResult['action'] = !storedEntry
      ? 'initial'
      : storedEntry.log?.last_entry_datetime === baseline?.last_entry_datetime
        ? 'no-change'
        : 'approved';
    const pendingDriftState = baseline && action !== 'no-change'
      ? { nodePath, state: { hash: '', files: {}, log: baseline } }
      : undefined;
    return { action, currentHash: '', previousHash: storedEntry?.hash, gcPaths, pendingDriftState };
  }

  const projectRoot = path.dirname(graph.rootPath);

  // ── Effective aspects — skip the REVIEWER for nodes with no non-draft ──
  // aspects. The reviewer is dormant, but the mandatory log gate is NOT: it
  // depends only on the node type's log_required flag and whether source files
  // changed since the last approve — never on aspect status. So this branch
  // still enforces the log requirement before short-circuiting the reviewer.
  if (!hasNonDraftEffectiveAspects(node, graph)) {
    const sourceChangedDraft = await sourceFilesChanged(node, graph, projectRoot, storedEntry);
    if (logRequired && sourceChangedDraft.length > 0 && !hasFreshLogEntry(logSnapshot.content, storedEntry?.log)) {
      return mandatoryLogRefusal(node, nodePath, sourceChangedDraft);
    }
    const gcPaths = await runGC(graph);
    if (!logSnapshot.existed) {
      return { action: 'approved', currentHash: '', gcPaths };
    }
    const baseline = computeLogBaseline(logSnapshot.content);
    const action: ApproveResult['action'] = !storedEntry
      ? 'initial'
      : storedEntry.log?.last_entry_datetime === baseline?.last_entry_datetime
        ? 'no-change'
        : 'approved';
    const pendingDriftState = baseline && action !== 'no-change'
      ? { nodePath, state: { hash: '', files: {}, log: baseline } }
      : undefined;
    return { action, currentHash: '', previousHash: storedEntry?.hash, gcPaths, pendingDriftState };
  }

  // ── First approve (no baseline) ──────────────────────────
  if (!storedEntry) {
    const trackedFiles = collectTrackedFiles(node, graph);

    // Mandatory entry check: first approve with source files requires a log
    // entry. With no baseline, "fresh entry" reduces to "any entry exists".
    const sourcePathsFirst = trackedFiles
      .filter((tf) => tf.layer === 'source')
      .map((tf) => toPosixPath(tf.path.trim()));
    if (sourcePathsFirst.length > 0 && logRequired && !hasFreshLogEntry(logSnapshot.content, undefined)) {
      return mandatoryLogRefusal(node, nodePath, sourcePathsFirst);
    }

    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot,
      trackedFiles,
      undefined,
      excludePrefixes,
    );

    const gcPaths = await runGC(graph);
    const logBaseline = logSnapshot.existed ? computeLogBaseline(logSnapshot.content) : undefined;

    return {
      action: 'initial',
      previousHash: undefined,
      currentHash: canonicalHash,
      gcPaths,
      pendingDriftState: {
        nodePath,
        state: {
          hash: canonicalHash,
          files: fileHashes,
          mtimes: fileMtimes,
          ...(logBaseline ? { log: logBaseline } : {}),
        },
      },
    };
  }

  // ── Existing baseline — compute changes ───────────────
  // Pass the stored baseline so the check-touched layer (cross-node files
  // read by a deterministic aspect) participates in drift detection here too.
  const trackedFiles = collectTrackedFiles(node, graph, storedEntry);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  // A corrupted/hand-edited baseline may drop `files` entirely (the store does
  // no runtime shape validation). Treat a missing map as "no previously-tracked
  // files" so every current file reads as new/changed (correct cold-start),
  // rather than crashing on undefined access below.
  const storedFiles = storedEntry.files ?? {};
  const storedFileData = storedEntry.files
    ? { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} }
    : undefined;
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot,
    trackedFiles,
    storedFileData,
    excludePrefixes,
  );

  // Resolve each changed file's drift layer (source vs upstream cascade),
  // handling directory-mapping expansion. Shared with classifyDrift in check.ts.
  const resolveLayer = buildLayerResolver(trackedFiles);

  const yggPrefix = yggPrefixOf(graph);

  // Classify changed files into two categories
  const changedSource: string[] = [];
  const changedUpstream: AnnotatedChange[] = [];

  // Check current vs stored
  for (const [filePath, hash] of Object.entries(fileHashes)) {
    const storedHash = storedFiles[filePath];
    if (storedHash && storedHash === hash) continue;
    classifyChangedFile(filePath);
  }

  // Check deleted files
  for (const storedPath of Object.keys(storedFiles)) {
    if (storedPath in fileHashes) continue;
    classifyChangedFile(storedPath);
  }

  function classifyChangedFile(filePath: string): void {
    const layer = resolveLayer(filePath);
    const isGraph = toPosixPath(filePath.trim()).startsWith(yggPrefix);

    const normalizedFilePath = toPosixPath(filePath.trim());
    if (layer === 'source' || (!isGraph && !layer)) {
      changedSource.push(normalizedFilePath);
    } else if (layer) {
      // hierarchy, aspects, relational, flows = upstream
      changedUpstream.push({
        filePath: normalizedFilePath,
        annotation: annotateUpstreamChange(filePath, layer),
      });
    } else if (isGraph) {
      /* v8 ignore start -- defensive */
      changedUpstream.push({
        filePath: normalizedFilePath,
        annotation: annotateUpstreamChange(filePath, undefined),
      });
      /* v8 ignore stop */
    }
  }

  const sourceChanged = changedSource.length > 0;
  const upstreamChanged = changedUpstream.length > 0;

  // ── Mandatory entry check (source drift + log_required) ──
  // Gated only on log_required + a source change + the absence of a fresh log
  // entry. NOT gated on storedEntry?.log: a node first approved without a log
  // baseline (storedEntry.log undefined) must still be re-blocked when its
  // source later changes — "fresh" then means "any entry exists".
  if (sourceChanged && logRequired && !hasFreshLogEntry(logSnapshot.content, storedEntry.log)) {
    return mandatoryLogRefusal(node, nodePath, changedSource);
  }

  // ── Newly-active aspect detection ───────────────────────
  // A draft -> advisory/enforced flip does NOT change the canonical hash (status
  // is intentionally excluded from the hash for advisory<->enforced stability),
  // so hash-based drift detection alone would miss it and report "No changes" —
  // leaving the now-active aspect without a reviewer verdict and yg check
  // permanently red (aspect-newly-active). Detect it exactly as check.ts does:
  // an effective non-draft aspect with no recorded verdict in a non-legacy
  // baseline. Such a node must re-approve so the reviewer records the verdict.
  const newlyActiveAspects: string[] = [];
  if (storedEntry.aspectVerdicts !== undefined) {
    const statuses = computeEffectiveAspectStatuses(node, graph);
    for (const [aspectId, status] of statuses) {
      if (status === 'draft') continue;
      if (!storedEntry.aspectVerdicts[aspectId]) newlyActiveAspects.push(aspectId);
    }
  }
  const hasNewlyActiveAspect = newlyActiveAspects.length > 0;

  // ── Binary decision ─────────────────────────────────────
  let action: ApproveResult['action'];

  if (!sourceChanged && !upstreamChanged && !hasNewlyActiveAspect) {
    action = 'no-change';
  } else {
    action = 'approved';
  }

  const gcPaths = await runGC(graph);

  const logBaseline = logSnapshot.existed ? computeLogBaseline(logSnapshot.content) : undefined;
  const logChanged = logBaseline?.last_entry_datetime !== storedEntry.log?.last_entry_datetime;
  const pending = action === 'approved'
    ? {
        nodePath,
        state: {
          hash: canonicalHash,
          files: fileHashes,
          mtimes: fileMtimes,
          ...(logBaseline ? { log: logBaseline } : {}),
        },
      }
    : logBaseline && logChanged
    ? {
        nodePath,
        state: {
          hash: storedEntry.hash,
          files: storedEntry.files,
          ...(storedEntry.mtimes ? { mtimes: storedEntry.mtimes } : {}),
          log: logBaseline,
        },
      }
    : {
        // no-change, no log update — populate from baseline so structure dispatch
        // can run and update checkTouchedFiles without violating the
        // pendingDriftState-exists contract.
        nodePath,
        state: structuredClone(storedEntry),
      };

  return {
    action,
    previousHash: storedEntry.hash,
    currentHash: canonicalHash,
    changedSource: sourceChanged ? changedSource : undefined,
    changedUpstream: upstreamChanged ? changedUpstream : undefined,
    gcPaths,
    pendingDriftState: pending,
  };
}

/**
 * Gate-only mandatory-log check for an ALL-DRAFT node. Enforces the log
 * requirement (a source change on a `log_required` node needs a fresh entry)
 * WITHOUT running GC or touching the baseline — so the node's prior baseline
 * (and its carried-forward checkTouchedFiles) is preserved across a draft toggle.
 * Returns a refusal result, or null when the gate passes. The reviewer is skipped
 * for an all-draft node, but the log gate is NOT — it is independent of aspect
 * status. The CLI uses this instead of a full approveNode for the all-draft case.
 */
export async function evaluateAllDraftLogGate(
  graph: Graph,
  nodePath: string,
): Promise<ApproveResult | null> {
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`Node '${nodePath}' does not exist.`);
  if (!logRequiredFor(node, graph)) return null;
  const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);
  const logSnapshot = await snapshotLog(graph.rootPath, nodePath);
  const projectRoot = path.dirname(graph.rootPath);
  const changed = await sourceFilesChanged(node, graph, projectRoot, storedEntry);
  if (changed.length > 0 && !hasFreshLogEntry(logSnapshot.content, storedEntry?.log)) {
    return mandatoryLogRefusal(node, nodePath, changed);
  }
  return null;
}

// ── Log requirement helpers ────────────────────────────────

/**
 * The node type's log_required flag (default true). Determines whether a fresh
 * log entry is mandatory when source files change. Independent of aspect status.
 */
function logRequiredFor(node: GraphNode, graph: Graph): boolean {
  const archType = graph.architecture.node_types[node.meta.type];
  return archType?.log_required ?? true;
}

/**
 * True when the log contains an entry NEWER than the last baselined one — i.e.
 * a fresh entry written for the current approve cycle. With no prior log
 * baseline (storedLog undefined), any entry counts as fresh.
 */
function hasFreshLogEntry(
  logContent: string,
  storedLog: { last_entry_datetime: string } | undefined,
): boolean {
  const newest = parseLog(logContent).at(-1);
  if (!newest) return false;
  if (!storedLog) return true;
  return newest.datetime !== storedLog.last_entry_datetime;
}

/** Build the refusal for a missing mandatory log entry on a source change. */
function mandatoryLogRefusal(
  node: GraphNode,
  nodePath: string,
  changedSource: string[],
): ApproveResult {
  const refuseReasonData: IssueMessage = {
    what: `No log entry found — mandatory entry required when source files change:\n${changedSource.map((f) => '  ' + f).join('\n')}`,
    why: `Node type '${node.meta.type}' has log_required: true — every source change requires a justification entry.`,
    next: `yg log add --node ${nodePath} --reason '<justification>'`,
  };
  return { action: 'refused', currentHash: '', refuseReasonData };
}

/**
 * Detect whether any source-layer file changed versus the stored baseline.
 * Used by the all-draft branch (where the reviewer is skipped but the log gate
 * still applies). With no baseline, the presence of any source file counts as
 * a change (mirrors the first-approve trigger).
 */
async function sourceFilesChanged(
  node: GraphNode,
  graph: Graph,
  projectRoot: string,
  storedEntry: { files: Record<string, string>; mtimes?: Record<string, number> } | undefined,
): Promise<string[]> {
  const trackedFiles = collectTrackedFiles(node, graph);
  const sourceTracked = trackedFiles.filter((tf) => tf.layer === 'source');
  if (sourceTracked.length === 0) return [];

  const excludePrefixes = getChildMappingExclusions(graph, node.path);
  // A corrupted/hand-edited baseline may drop `files` entirely; treat a missing
  // map as "no previously-tracked files" to match the cold-start guard used in
  // the main approve body, rather than crashing on undefined access below.
  const storedFiles = storedEntry?.files ?? {};
  const { fileHashes } = await hashTrackedFiles(
    projectRoot,
    sourceTracked,
    storedEntry ? { hashes: storedFiles, mtimes: storedEntry.mtimes ?? {} } : undefined,
    excludePrefixes,
  );

  // Normalize at the output boundary: this function's result is emitted (it
  // flows into the mandatory-log refusal message, part of the public approve
  // result written to CLI output), so guarantee POSIX form on the way out.
  const norm = (p: string): string => toPosixPath(p);

  // No baseline → first approve: any present source file is a "change".
  if (!storedEntry) return Object.keys(fileHashes).map(norm);

  const changed: string[] = [];
  for (const [filePath, hash] of Object.entries(fileHashes)) {
    if (storedFiles[filePath] !== hash) changed.push(norm(filePath));
  }
  for (const storedPath of Object.keys(storedFiles)) {
    // Only consider source-layer stored paths we are tracking now; a deleted
    // tracked source file also counts as a change.
    if (!(storedPath in fileHashes) && sourceTracked.some((tf) => {
      const key = norm(tf.path.trim());
      return storedPath === key || storedPath.startsWith(key + '/');
    })) {
      changed.push(norm(storedPath));
    }
  }
  return changed;
}

// ── Log helpers ────────────────────────────────────────────

interface LogSnapshot {
  content: string;
  existed: boolean;
}

async function snapshotLog(yggRoot: string, nodePath: string): Promise<LogSnapshot> {
  const logPath = path.join(yggRoot, 'model', nodePath, 'log.md');
  try {
    const st = await lstatFile(logPath);
    if (st.isSymbolicLink()) {
      throw new Error(`log.md at .yggdrasil/model/${nodePath}/log.md is a symlink — refuse to approve`);
    }
    if (st.nlink > 1) {
      throw new Error(`log.md at .yggdrasil/model/${nodePath}/log.md has multiple hardlinks — refuse to approve`);
    }
    const content = await readTextFile(logPath);
    return { content, existed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      debugWrite(`[approve] log.md not found at ${toPosixPath(logPath)} — treating as absent`);
      return { content: '', existed: false };
    }
    /* v8 ignore next */
    throw err;
  }
}

function computeLogBaseline(
  content: string,
): { last_entry_datetime: string; prefix_hash: string } | undefined {
  const entries = parseLog(content);
  if (entries.length === 0) return undefined;
  const newest = entries[entries.length - 1];
  const bytes = Buffer.from(content, 'utf-8');
  const prefix = bytes.subarray(0, newest.offsetEnd);
  return {
    last_entry_datetime: newest.datetime,
    prefix_hash: createHash('sha256').update(prefix).digest('hex'),
  };
}

function classifyViolationZone(
  violations: { line: number; reason: string }[],
  content: string,
  storedDatetime: string | undefined,
): 'pre-baseline' | 'post-baseline' {
  const structural = new Set(['invalid_start', 'unclosed_code_fence']);
  if (violations.every((v) => structural.has(v.reason))) return 'post-baseline';
  if (!storedDatetime) return 'post-baseline';
  const entries = parseLog(content);
  const boundary = entries.find((e) => e.datetime === storedDatetime);
  /* v8 ignore next */
  if (!boundary) return 'pre-baseline';
  const bytes = Buffer.from(content, 'utf-8');
  let line = 1;
  for (let i = 0; i < boundary.offsetEnd && i < bytes.length; i++) {
    if (bytes[i] === 0x0a) line++;
  }
  const baselineLine = line;
  const nonStructural = violations.filter((v) => !structural.has(v.reason));
  return nonStructural.some((v) => v.line < baselineLine) ? 'pre-baseline' : 'post-baseline';
}

// ── Helpers ────────────────────────────────────────────────

/* v8 ignore start -- tested in check.ts */
/** Compute child mapping exclusions (child-wins model) */
export function getChildMappingExclusions(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const parentMappings = normalizeMappingPaths(node.meta.mapping);
  if (parentMappings.length === 0) return [];

  const exclusions: string[] = [];
  for (const [childPath, childNode] of graph.nodes) {
    if (childPath === nodePath || !childPath.startsWith(nodePath + '/')) continue;
    const childMappings = normalizeMappingPaths(childNode.meta.mapping);
    for (const cm of childMappings) {
      for (const pm of parentMappings) {
        if (cm === pm || cm.startsWith(pm + '/')) {
          exclusions.push(cm);
        }
      }
    }
  }
  return exclusions;
}
/* v8 ignore stop */

/** Annotate an upstream changed file with a human-readable category label. */
export function annotateUpstreamChange(filePath: string, layer: TrackedFileLayer | undefined): string {
  const normalized = toPosixPath(filePath.trim());
  if (layer === 'check-touched') return 'structure aspect tracked file';
  if (layer === 'aspects' || normalized.includes('/aspects/')) return 'aspect content';
  if (normalized.includes('/flows/')) return 'flow description';
  if (layer === 'hierarchy') return 'parent metadata';
  if (layer === 'relational') return 'dependency metadata';
  return 'upstream content';
}

/** GC orphaned drift state — remove entries for nodes not in graph or with no non-draft effective aspects */
async function runGC(graph: Graph): Promise<string[]> {
  const validPaths = new Set(graph.nodes.keys());
  return garbageCollectDriftState(
    graph.rootPath,
    validPaths,
    (nodePath) => {
      const node = graph.nodes.get(nodePath);
      if (!node) return false;
      return hasNonDraftEffectiveAspects(node, graph);
    },
  );
}

/** Persist drift state after LLM verification passes */
export async function commitApproval(yggRoot: string, result: ApproveResult): Promise<void> {
  if (result.pendingDriftState) {
    await writeNodeDriftState(yggRoot, result.pendingDriftState.nodePath, result.pendingDriftState.state);
  }
}

/** Load source file contents from disk */
export async function loadSourceFiles(
  filePaths: string[],
  projectRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  for (const filePath of filePaths) {
    // Normalize at the output boundary: this is a public function and the path
    // is emitted both into the returned source list (e.g. the dry-run reviewer
    // prompt) and the debug log. Not every caller normalizes its inputs, so
    // guarantee POSIX form here, in BOTH the success and the skipped branch.
    const posixPath = toPosixPath(filePath);
    try {
      const content = await readTextFile(path.join(projectRoot, filePath));
      results.push({ path: posixPath, content });
    } catch (err) {
      debugWrite(`[approve] skipped unreadable file ${posixPath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/** Resolve aspects with inline content for LLM verification */
export function resolveAspects(
  node: GraphNode,
  graph: Graph,
): Array<{ id: string; description: string; content: string; reviewer?: import('../model/graph.js').AspectReviewerSpec; references?: Array<{ path: string; description?: string }> }> {
  const allAspectIds = computeEffectiveAspects(node, graph);

  const result: Array<{ id: string; description: string; content: string; reviewer?: import('../model/graph.js').AspectReviewerSpec; references?: Array<{ path: string; description?: string }> }> = [];
  for (const aspectId of allAspectIds) {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    if (!aspectDef) continue;
    const contentFiles = aspectDef.artifacts.filter(a => a.filename.endsWith('.md'));
    const isDeterministic = aspectDef.reviewer?.type === 'deterministic';
    if (!isDeterministic && contentFiles.length === 0) continue;
    const content = contentFiles.map(a => a.content).join('\n\n');
    result.push({ id: aspectId, description: aspectDef.description ?? aspectDef.name, content, reviewer: aspectDef.reviewer, references: aspectDef.references });
  }
  return result;
}
