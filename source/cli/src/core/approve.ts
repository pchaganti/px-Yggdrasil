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
import { collectTrackedFiles } from './context-files.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { computeEffectiveAspects } from './graph/aspects.js';
import { readTextFile, lstatFile } from '../io/graph-fs.js';
import { createHash } from 'node:crypto';
import { debugWrite } from '../utils/debug-log.js';
import path from 'node:path';
import { parseLog } from './parsing/log-parser.js';
import { validateFormat } from './log-format.js';
import { validateAppendOnly } from './log-integrity.js';
import type { IssueMessage } from '../model/validation.js';

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

  // ── Logical node (no mapping) — log-only path ───────────
  if (mappingPaths.length === 0) {
    if (!logSnapshot.existed) {
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

  // ── Effective aspects — auto-approve aspect-free nodes ──
  const effectiveAspects = computeEffectiveAspects(node, graph);
  if (effectiveAspects.size === 0) {
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

  const projectRoot = path.dirname(graph.rootPath);

  // ── First approve (no baseline) ──────────────────────────
  if (!storedEntry) {
    const trackedFiles = collectTrackedFiles(node, graph);

    // Mandatory entry check: first approve with source files requires a log entry
    const nodeTypeFirst = node.meta.type;
    const archTypeFirst = graph.architecture.node_types[nodeTypeFirst];
    const logRequiredFirst = archTypeFirst?.log_required ?? true;
    const sourcePathsFirst = trackedFiles
      .filter((tf) => tf.layer === 'source')
      .map((tf) => tf.path.trim().replace(/\\/g, '/').replace(/\/+$/, ''));
    if (sourcePathsFirst.length > 0 && logRequiredFirst && parseLog(logSnapshot.content).length === 0) {
      const noLogFirstMd: IssueMessage = {
        what: `No log entry found — mandatory entry required when source files are added:\n${sourcePathsFirst.map((p) => '  ' + p).join('\n')}`,
        why: `Node type '${nodeTypeFirst}' has log_required: true — every source change requires a justification entry.`,
        next: `yg log add --node ${nodePath} --reason '<justification>'`,
      };
      return {
        action: 'refused',
        currentHash: '',
        refuseReasonData: noLogFirstMd,
      };
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
  const trackedFiles = collectTrackedFiles(node, graph);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  const storedFileData = storedEntry.files
    ? { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} }
    : undefined;
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot,
    trackedFiles,
    storedFileData,
    excludePrefixes,
  );

  // Build layer map (same logic as classifyDrift in check.ts)
  const fileLayerMap = new Map<string, TrackedFileLayer>();
  const dirPrefixes: Array<{ prefix: string; layer: TrackedFileLayer }> = [];
  for (const tf of trackedFiles) {
    const tfKey = tf.path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!fileLayerMap.has(tfKey)) {
      fileLayerMap.set(tfKey, tf.layer);
    }
    const trimmedPath = tf.path.trim().replace(/\\/g, '/');
    /* v8 ignore next 3 -- normalizeMappingPaths strips trailing slashes; this branch is unreachable */
    if (trimmedPath.endsWith('/')) {
      dirPrefixes.push({ prefix: tfKey + '/', layer: tf.layer });
    }
  }

  function resolveLayer(filePath: string): TrackedFileLayer | undefined {
    const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const direct = fileLayerMap.get(normalized);
    if (direct) return direct;
    for (const { prefix, layer } of dirPrefixes) {
      /* v8 ignore next -- dirPrefixes is always empty (see normalizeMappingPaths) */
      if (normalized.startsWith(prefix)) return layer;
    }
    return undefined;
  }

  const yggPrefix = path
    .relative(projectRoot, graph.rootPath)
    .split(/[\\/]/)
    .join('/');

  // Classify changed files into two categories
  const changedSource: string[] = [];
  const changedUpstream: AnnotatedChange[] = [];

  // Check current vs stored
  for (const [filePath, hash] of Object.entries(fileHashes)) {
    const storedHash = storedEntry.files[filePath];
    if (storedHash && storedHash === hash) continue;
    classifyChangedFile(filePath);
  }

  // Check deleted files
  for (const storedPath of Object.keys(storedEntry.files)) {
    if (storedPath in fileHashes) continue;
    classifyChangedFile(storedPath);
  }

  function annotateUpstreamChange(
    filePath: string,
    layer: TrackedFileLayer | undefined,
  ): string {
    const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (layer === 'aspects' || normalized.includes('/aspects/')) return 'aspect content';
    if (normalized.includes('/flows/')) return 'flow description';
    if (layer === 'hierarchy') return 'parent metadata';
    if (layer === 'relational') return 'dependency metadata';
    return 'upstream content';
  }

  function classifyChangedFile(filePath: string): void {
    const layer = resolveLayer(filePath);
    const isGraph = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').startsWith(yggPrefix);

    const normalizedFilePath = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
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
  const nodeType = node.meta.type;
  const archType = graph.architecture.node_types[nodeType];
  const logRequired = archType?.log_required ?? true;

  if (sourceChanged && logRequired && storedEntry?.log) {
    const newestEntry = parseLog(logSnapshot.content).at(-1);
    if (!newestEntry || newestEntry.datetime === storedEntry.log.last_entry_datetime) {
      const noLogChangedMd: IssueMessage = {
        what: `No log entry found — mandatory entry required when source files change:\n${changedSource.map((f) => '  ' + f).join('\n')}`,
        why: `Node type '${nodeType}' has log_required: true — every source change requires a justification entry.`,
        next: `yg log add --node ${nodePath} --reason '<justification>'`,
      };
      return {
        action: 'refused',
        currentHash: '',
        refuseReasonData: noLogChangedMd,
      };
    }
  }

  // ── Binary decision ─────────────────────────────────────
  let action: ApproveResult['action'];

  if (!sourceChanged && !upstreamChanged) {
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
    : undefined;

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
      debugWrite(`[approve] log.md not found at ${logPath} — treating as absent`);
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
function getChildMappingExclusions(graph: Graph, nodePath: string): string[] {
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

/** GC orphaned drift state — remove entries for nodes not in graph or with zero effective aspects */
async function runGC(graph: Graph): Promise<string[]> {
  const validPaths = new Set(graph.nodes.keys());
  return garbageCollectDriftState(
    graph.rootPath,
    validPaths,
    (nodePath) => {
      const node = graph.nodes.get(nodePath);
      if (!node) return false;
      const effective = computeEffectiveAspects(node, graph);
      return effective.size > 0;
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
    try {
      const content = await readTextFile(path.join(projectRoot, filePath));
      results.push({ path: filePath, content });
    } catch (err) {
      debugWrite(`[approve] skipped unreadable file ${filePath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/** Resolve aspects with inline content for LLM verification */
export function resolveAspects(
  node: GraphNode,
  graph: Graph,
): Array<{ id: string; description: string; content: string; reviewer?: 'ast' | 'llm' }> {
  const allAspectIds = computeEffectiveAspects(node, graph);

  const result: Array<{ id: string; description: string; content: string; reviewer?: 'ast' | 'llm' }> = [];
  for (const aspectId of allAspectIds) {
    const aspectDef = graph.aspects.find(a => a.id === aspectId);
    if (!aspectDef) continue;
    const contentFiles = aspectDef.artifacts.filter(a => a.filename.endsWith('.md'));
    if (contentFiles.length === 0) continue;
    const content = contentFiles.map(a => a.content).join('\n\n');
    result.push({ id: aspectId, description: aspectDef.description ?? aspectDef.name, content, reviewer: aspectDef.reviewer });
  }
  return result;
}
