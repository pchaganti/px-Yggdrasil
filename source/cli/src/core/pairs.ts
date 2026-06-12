/**
 * source/cli/src/core/pairs.ts
 *
 * Read-side foundation for the verdict lock: computes the expected set of
 * (aspect, unit) pairs for a loaded graph and per-node source fingerprints.
 *
 * Public contract (consumed by future check/fill stages):
 *   computeExpectedPairs   — expected pairs for the whole graph
 *   computeSourceFingerprint — sha256 fold over sorted [path, sha256(bytes)] of
 *                              all mapped files (child carve-out applied, binaries
 *                              included by bytes). Format: "path:hash\n..." lines
 *                              sorted, folded with sha256 via hashString.
 *
 * Design:
 *   - scope applies AFTER the 7-channel effectiveness walk, never inside it.
 *   - Aggregate aspects are always excluded (no own reviewer, no own verdict).
 *   - Draft aspects are excluded by default; pass { includeDraft: true } for GC.
 *   - LLM subject sets exclude binary files (by extension); deterministic keeps them.
 *   - Empty subject set → no pair for that (aspect, node) — vacuous pass.
 *   - Nodes with empty mapping → no pairs at all.
 *   - Pairs are sorted by aspectId, then unitKey for deterministic output.
 */

import path from 'node:path';

import type { Graph } from '../model/graph.js';
import type { AspectStatus } from '../model/graph.js';
import type { UnitKey } from '../model/lock.js';
import { nodeUnit, fileUnit } from '../model/lock.js';
import { expandMappingPaths, hashFile, hashString } from '../io/hash.js';
import { normalizeMappingPaths } from '../io/paths.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  isAggregateAspect,
} from './graph/aspects.js';
import { evaluateFileWhen } from './file-when-evaluator.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { BINARY_EXTENSIONS } from '../utils/binary-extensions.js';
import { mappingEntryMatchesFile } from '../utils/mapping-path.js';

// ============================================================
// Public types
// ============================================================

export interface ExpectedPair {
  aspectId: string;
  kind: 'llm' | 'deterministic';
  unitKey: UnitKey;          // nodeUnit(nodePath) for per-node; fileUnit(path) per-file
  nodePath: string;          // owning node
  status: AspectStatus;      // effective status on the node (for rendering/severity)
  subjectFiles: string[];    // repo-relative POSIX, sorted
}

/**
 * Represents a candidate subject file that could not be read during scope.files
 * evaluation. The file is excluded from the subject set (it cannot be hashed or
 * reviewed) and is surfaced here so callers can turn it into a blocking error.
 *
 * Callers MUST surface non-empty unreadable as a blocking error — a silently
 * dropped file can turn an enforced rule into a vacuous pass.
 */
export interface UnreadableSubject {
  nodePath: string;
  aspectId: string;
  path: string;     // repo-relative POSIX
  reason: string;   // from evaluateFileWhen's unreadableReason (or a clear fallback)
}

/**
 * Return shape of computeExpectedPairs.
 *
 * Callers MUST surface a non-empty `unreadable` array as a blocking error.
 * Silently ignoring it means a file that failed the content filter is dropped
 * from the review surface, which can turn an enforced rule into a vacuous pass
 * (zero pairs = no reviewer invocation = implicit green).
 */
export interface PairComputation {
  pairs: ExpectedPair[];
  unreadable: UnreadableSubject[];
}

export interface ComputePairsOptions {
  /** When true, include draft aspects (used by GC universe). Default: false. */
  includeDraft?: boolean;
}

// ============================================================
// Sanctioned refactor: getChildMappingExclusions moved here.
// Re-imported in approve.ts and check.ts (import-only change, no behavior change).
// ============================================================

/**
 * Compute child mapping exclusions for the child-wins model.
 *
 * Returns the list of mapping entries owned by descendant nodes so that a
 * parent's subject-file set can exclude files already mapped by a child.
 * Exact match with the implementations previously in approve.ts (exported) and
 * check.ts (private) — both are removed and this is the single source of truth.
 */
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

// ============================================================
// computeExpectedPairs
// ============================================================

/**
 * Compute the complete expected set of (aspect, unit) pairs for a graph.
 *
 * Algorithm per node:
 *   1. Collect effective aspects (7-channel cascade, when-filtered).
 *   2. Skip aggregates (no reviewer, no verdict).
 *   3. Skip draft unless includeDraft.
 *   4. Expand mapping paths (child carve-out applied).
 *   5. Filter by scope.files predicate (evaluateFileWhen) — absent = all files.
 *      Files where evaluateFileWhen reports unreadable: true are EXCLUDED from
 *      the subject set and recorded in the returned `unreadable` array.
 *   6. For LLM aspects: additionally exclude binaries (by extension).
 *   7. Empty subject set → no pair.
 *   8. per: node → one pair; per: file → one pair per subject file.
 *
 * Output `pairs` is sorted by aspectId, then unitKey for deterministic comparison.
 * Callers MUST surface a non-empty `unreadable` array as a blocking error.
 *
 * Note: files that disappear between mapping expansion (step 4) and scope
 * evaluation (step 5) simply never enter the subject set — mapping expansion
 * is a snapshot and missing paths are silently dropped at that stage. The
 * explicit `unreadable` channel covers only content-filter read failures (EACCES
 * or similar) on files that were successfully enumerated.
 */
export async function computeExpectedPairs(
  graph: Graph,
  opts?: ComputePairsOptions,
): Promise<PairComputation> {
  const includeDraft = opts?.includeDraft ?? false;
  const projectRoot = path.dirname(graph.rootPath);
  const cache = new FileContentCache();

  const pairs: ExpectedPair[] = [];
  const unreadableMap = new Map<string, UnreadableSubject>(); // key: nodePath+aspectId+path

  for (const [nodePath, node] of graph.nodes) {
    // Expand the node's mapped files (gitignore-aware, child carve-out applied).
    const rawMapping = normalizeMappingPaths(node.meta.mapping);
    if (rawMapping.length === 0) continue; // no mapping → no pairs for this node

    // O(nodes²) with one FS walk per node — fine at current scale; if check latency grows, precompute a child-exclusion index per run.
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);
    const allExpanded = await expandMappingPaths(projectRoot, rawMapping);
    const nodeFiles = excludePrefixes.length > 0
      ? allExpanded.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
      : allExpanded;

    if (nodeFiles.length === 0) continue; // after carve-out, nothing left

    // Effective aspects and their statuses for this node.
    let effectiveIds: Set<string>;
    let statuses: Map<string, AspectStatus>;
    try {
      effectiveIds = computeEffectiveAspects(node, graph);
      statuses = computeEffectiveAspectStatuses(node, graph);
    } catch {
      // ImpliesCycleError or similar structural error — skip this node; the
      // validator will catch and report the cycle separately.
      continue;
    }

    for (const aspectId of effectiveIds) {
      // Aggregates never produce a pair (no own reviewer, no own verdict).
      if (isAggregateAspect(graph, aspectId)) continue;

      const effectiveStatus = statuses.get(aspectId) ?? 'enforced';
      if (!includeDraft && effectiveStatus === 'draft') continue;

      const aspectDef = graph.aspects.find((a) => a.id === aspectId);
      if (!aspectDef) continue;

      // isAggregateAspect already guarded above; reviewer.type is 'llm' | 'deterministic' here.
      const kind = aspectDef.reviewer.type as 'llm' | 'deterministic';

      const scope = aspectDef.scope;

      // ── Step 1: scope.files filter (path + content predicate) ──────────
      let scopeFiltered = nodeFiles;
      if (scope?.files) {
        const results = await Promise.all(
          nodeFiles.map((p) =>
            evaluateFileWhen(scope.files!, {
              absPath: path.resolve(projectRoot, p),
              repoRelPath: p,
              projectRoot,
              cache,
            }),
          ),
        );
        // Collect unreadable files so they can be surfaced as blocking errors.
        // A silently dropped file can turn an enforced rule into a vacuous pass.
        for (let i = 0; i < nodeFiles.length; i++) {
          const r = results[i];
          if (r.unreadable) {
            const key = `${nodePath}\0${aspectId}\0${nodeFiles[i]}`;
            if (!unreadableMap.has(key)) {
              unreadableMap.set(key, {
                nodePath,
                aspectId,
                path: nodeFiles[i],
                reason: r.unreadableReason ?? 'unreadable',
              });
            }
          }
        }
        scopeFiltered = nodeFiles.filter((_, i) => results[i].result);
      }

      // ── Step 2: LLM aspects additionally exclude binary files ───────────
      let subjectFiles = scopeFiltered;
      if (kind === 'llm') {
        subjectFiles = scopeFiltered.filter(
          (p) => !BINARY_EXTENSIONS.has(path.extname(p).toLowerCase()),
        );
      }

      // Empty subject set → vacuous pass, no pair.
      if (subjectFiles.length === 0) continue;

      const sortedSubjects = [...subjectFiles].sort();

      // ── Step 3: per: node (or absent scope) → one pair ─────────────────
      const per = scope?.per ?? 'node';
      if (per === 'node') {
        pairs.push({
          aspectId,
          kind,
          unitKey: nodeUnit(nodePath),
          nodePath,
          status: effectiveStatus,
          subjectFiles: sortedSubjects,
        });
      } else {
        // per: file → one pair per subject file
        for (const filePath of sortedSubjects) {
          pairs.push({
            aspectId,
            kind,
            unitKey: fileUnit(filePath),
            nodePath,
            status: effectiveStatus,
            subjectFiles: [filePath],
          });
        }
      }
    }
  }

  // Deterministic output ordering: aspectId first, then unitKey.
  pairs.sort((a, b) => {
    if (a.aspectId < b.aspectId) return -1;
    if (a.aspectId > b.aspectId) return 1;
    if (a.unitKey < b.unitKey) return -1;
    if (a.unitKey > b.unitKey) return 1;
    return 0;
  });

  return { pairs, unreadable: Array.from(unreadableMap.values()) };
}

// ============================================================
// computeSourceFingerprint
// ============================================================

/**
 * Compute the per-node source fingerprint.
 *
 * Algorithm:
 *   1. Expand all mapped files (child carve-out applied).
 *   2. Hash every file (binaries included — hashFile reads raw bytes).
 *   3. Build sorted 'path:hash' lines and fold with sha256.
 *   4. Return undefined if the node maps nothing.
 *
 * Fingerprint format (local-state contract, documented here for stability):
 *   sha256(join('\n', sorted(['<repoRelPosix>:<sha256hex>', ...])))
 *
 * This is INDEPENDENT of scope filters — the fingerprint covers the full
 * mapping and is used to detect source drift, not to reproduce subject sets.
 * Binary files are included by their raw bytes (not their extension).
 *
 * TOCTOU asymmetry: a mapped file deleted between enumeration (step 1) and
 * hashing (step 2) causes hashFile to throw, which propagates as a rejected
 * promise — fail-closed for drift state. This is intentional: a vanished file
 * must not silently produce the same fingerprint as the intact node, which
 * would hide drift. By contrast, computeExpectedPairs treats files that
 * disappear between enumeration and scope evaluation as silently absent (they
 * never enter the subject set); only content-filter read failures surface via
 * the explicit `unreadable` channel.
 */
export async function computeSourceFingerprint(
  graph: Graph,
  nodePath: string,
): Promise<string | undefined> {
  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;

  const rawMapping = normalizeMappingPaths(node.meta.mapping);
  if (rawMapping.length === 0) return undefined;

  const projectRoot = path.dirname(graph.rootPath);
  const excludePrefixes = getChildMappingExclusions(graph, nodePath);
  const allExpanded = await expandMappingPaths(projectRoot, rawMapping);
  const nodeFiles = excludePrefixes.length > 0
    ? allExpanded.filter((p) => !excludePrefixes.some((ep) => mappingEntryMatchesFile(ep, p)))
    : allExpanded;

  if (nodeFiles.length === 0) return undefined;

  // Hash all files (binaries included by bytes).
  const pairs = await Promise.all(
    nodeFiles.map(async (p) => {
      const absPath = path.resolve(projectRoot, p);
      const hash = await hashFile(absPath);
      return `${p}:${hash}`;
    }),
  );

  // Sort and fold into a single sha256.
  // Format: sorted 'repoRelPosixPath:sha256hex' lines joined by '\n', folded with sha256.
  const digest = pairs.sort().join('\n');
  return hashString(digest);
}
