import type { Graph, GraphNode } from '../model/graph.js';
import type {
  DriftCategory,
  DriftFileChange,
  DriftNodeState,
  IdentityCause,
  NodeLifecycleState,
  TrackedFileLayer,
} from '../model/drift.js';
import {
  diffIdentity,
  identityCauseToken,
  identityCauseLayer as identityCauseLayerOf,
  describeCascadeCause,
  describeIdentityCause,
  categorizeFile,
  buildCheckTouchedOwnerMap,
} from './drift-cause.js';
import type { ValidationIssue } from '../model/validation.js';
import { readDriftState, readNodeDriftState, garbageCollectDriftState } from '../io/drift-state-store.js';
import { DEFAULT_COVERAGE } from '../io/config-parser.js';
import { hashTrackedFiles } from '../io/hash.js';
import { collectTrackedFiles, buildLayerResolver } from './graph/files.js';
import { normalizeMappingPaths } from '../io/paths.js';
import { validate } from './validator.js';
import { computeEffectiveAspectStatuses, hasNonDraftEffectiveAspects, isAggregateAspect, ImpliesCycleError } from './graph/aspects.js';
import { readTextFile, fileAccess } from '../io/graph-fs.js';
import path from 'node:path';
import { validateAppendOnly } from './log-integrity.js';
import { STRUCTURAL_CODES, COMPLETENESS_CODES } from './check-codes.js';
import { validateFormat } from './log-format.js';
import { toPosixPath } from '../utils/posix.js';
import { excludeNestedGraphSubtrees } from '../io/repo-scanner.js';
import { mappingEntryMatchesFile } from '../utils/mapping-path.js';
import {
  aspectNewlyActiveMessage,
  aspectViolationEnforcedMessage,
  aspectViolationAdvisoryMessage,
} from '../formatters/aspect-status-messages.js';

// ── Types ──────────────────────────────────────────────────

export interface CheckIssue extends Omit<ValidationIssue, 'code'> {
  /** All issues have a code -- override optional from ValidationIssue */
  code: string;
  /** For source-drift: lifecycle state */
  lifecycleState?: NodeLifecycleState;
  /** For source-drift: changed files that are direct (source) */
  directChangedFiles?: DriftFileChange[];
  /** For upstream-drift: what caused the cascade */
  cascadeCauses?: CascadeCause[];
  /** For unmapped-files: uncovered file paths */
  uncoveredFiles?: string[];
  /** For unmapped-files: total count of uncovered files */
  uncoveredCount?: number;
  /** For aspect-newly-active / aspect-violation-*: the aspect this issue concerns */
  aspectId?: string;
}

export type { IdentityCause };

export interface CascadeCause {
  /**
   * Changed file path. For a real file this is its repo-relative POSIX path;
   * for an identity-element change (`identity` set) it is a stable display
   * token, NOT a path on disk — never resolve it against the filesystem.
   */
  file: string;
  /** Which layer the changed file belongs to */
  layer: TrackedFileLayer;
  /** Human-readable description, e.g. "aspect 'audit-logging' rules changed" */
  description: string;
  /**
   * Present when this cause is a typed identity-element change rather than a
   * real-file change. Attribution helpers match on this instead of parsing
   * `file`.
   */
  identity?: IdentityCause;
  /**
   * For a CROSS-node `check-touched` real-file change (the content of a file a
   * deterministic aspect on this node reads changed): the deterministic
   * aspect(s) whose stored read-set contains this path. Set by classifyDrift
   * from the stored typed identity, so cascade attribution does not re-read the
   * baseline. Empty/absent for non-check-touched causes.
   */
  attributedAspectIds?: string[];
}

export interface CheckResult {
  projectName: string;
  nodeCount: number;
  nodeTypeCounts: Map<string, number>;
  aspectCount: number;
  flowCount: number;
  coveredFiles: number;
  totalFiles: number;
  issues: CheckIssue[];
  /** Suggested next command based on highest-priority error */
  suggestedNext: string | null;
  /** Count of aspect-violation-advisory warnings (subset of issues). Surfaced as a footer tally. */
  advisoryWarnings: number;
  /** Count of (node, aspect) pairs where the aspect resolves to effective status 'draft'. */
  draftSkipped: number;
}

// ── Drift classification ───────────────────────────────────

/**
 * Classify drift for all mapped nodes as source-drift (direct) and/or upstream-drift (cascade).
 * A single node can produce BOTH a source-drift and an upstream-drift if it has direct and cascade changes.
 */
export async function classifyDrift(graph: Graph): Promise<CheckIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const issues: CheckIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping);
    if (mappingPaths.length === 0) continue;

    // An implies cycle makes effective-aspect resolution undefined for this
    // node. The static validator (`checkImpliesNoCycles`, run in `runCheck`
    // before drift) already emits the blocking, structured `aspect-implies-cycle`
    // error, so the graph is invalid and per-node drift is moot. Skip this node
    // rather than letting the cycle throw escape to the generic top-level
    // "file an issue" handler. Both `hasNonDraftEffectiveAspects` (status
    // fix-point) and `collectTrackedFiles` (implies DFS) below can raise it.
    try {
      await classifyNodeDrift(graph, projectRoot, nodePath, node, mappingPaths, issues);
    } catch (err) {
      if (err instanceof ImpliesCycleError) continue;
      throw err;
    }
  }

  await classifyLogState(graph, projectRoot, issues);

  return issues;
}

/**
 * Drift classification for ONE mapped node. Extracted from `classifyDrift` so
 * the per-node body can be wrapped in a single try/catch that skips the node on
 * an `ImpliesCycleError` (graph structurally invalid — validator already
 * reports the cycle). Pushes any source-drift / upstream-drift / per-aspect
 * issues into `issues`.
 */
async function classifyNodeDrift(
  graph: Graph,
  projectRoot: string,
  nodePath: string,
  node: GraphNode,
  mappingPaths: string[],
  issues: CheckIssue[],
): Promise<void> {
    // Nodes whose every effective aspect is draft auto-approve — skip drift
    // detection. Draft aspects are dormant: no baseline, no drift, no per-aspect
    // emission. If a non-draft aspect exists, fall through to the per-aspect
    // emission loop below so aspect-newly-active / aspect-violation-* fire.
    if (!hasNonDraftEffectiveAspects(node, graph)) return;

    const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);

    // No baseline -> unapproved (node exists but was never approved)
    if (!storedEntry) {
      const allMissing = await allPathsMissing(projectRoot, mappingPaths);
      const md = allMissing
        ? {
            what: `Mapping declared but source files never created:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
            why: 'Node specifies files that do not exist yet.',
            next: `Implement from the graph specification, then: yg approve --node ${nodePath}`,
          }
        : {
            what: `Node has never been approved (no baseline):\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
            why: 'Drift tracking is not active until the first approve.',
            next: `Verify source, then: yg approve --node ${nodePath}`,
          };
      issues.push({
        severity: 'error',
        code: allMissing ? 'source-drift' : 'unapproved',
        rule: allMissing ? 'source-drift' : 'unapproved',
        messageData: md,
        nodePath,
        lifecycleState: 'unapproved',
        directChangedFiles: [],
      });
      return;
    }

    // Check if all source paths are gone
    const sourceGone = await allPathsMissing(projectRoot, mappingPaths);
    if (sourceGone) {
      const sourceGoneMd = {
        what: `Mapped source files not found on disk:\n${mappingPaths.map(p => '  ' + p).join('\n')}`,
        why: 'Mapped files were deleted or moved.',
        next: `Re-create the file, or remove the mapping from yg-node.yaml.`,
      };
      issues.push({
        severity: 'error',
        code: 'source-drift',
        rule: 'source-drift',
        messageData: sourceGoneMd,
        nodePath,
        lifecycleState: 'missing',
        directChangedFiles: mappingPaths.map(p => ({ filePath: p, category: 'source' as DriftCategory })),
      });
      return;
    }

    // Per-aspect emission (aspect-newly-active / aspect-violation-*) runs
    // independent of file-hash drift. A refused advisory baseline must keep
    // emitting its warning every `yg check` even when no file changed.
    emitPerAspectIssues(node, graph, storedEntry, issues);

    // Collect tracked files + typed identity. Pass the stored baseline so the
    // per-aspect checkTouched set (cross-node files a deterministic aspect read)
    // participates in drift identity — editing such a file must drift this node.
    const { trackedFiles, identity } = collectTrackedFiles(node, graph, storedEntry);

    // Compute child mapping exclusions (child-wins model)
    const excludePrefixes = getChildMappingExclusions(graph, nodePath);

    // Hash and compare — fold the typed identity AND the stored per-aspect
    // verdicts into the canonical hash. Folding the stored verdicts here is what
    // makes a tampered verdict (e.g. a hand-edited refused->approved in the
    // committed .drift-state/*.json) drift: the recompute over the stored
    // verdicts no longer matches the stored hash.
    const storedFileData = { hashes: storedEntry.files, mtimes: storedEntry.mtimes ?? {} };
    const { canonicalHash, fileHashes } = await hashTrackedFiles(
      projectRoot, trackedFiles, storedFileData, excludePrefixes, identity, storedEntry.aspectVerdicts,
      false, // never reuse stored hashes by mtime in the check gate — always re-hash content
    );

    if (canonicalHash === storedEntry.hash) return; // No drift

    // Resolve each changed file's drift layer (source vs upstream cascade),
    // handling directory-mapping expansion. Shared with approveNode.
    const resolveLayer = buildLayerResolver(trackedFiles);

    // Find changed files
    const directChanges: DriftFileChange[] = [];
    const cascadeCauses: CascadeCause[] = [];

    // path → owning deterministic aspect id(s), from the stored typed identity's
    // per-aspect checkTouched maps. Lets a cross-node check-touched real-file
    // content change attribute to its owning aspect without a baseline re-read.
    const checkTouchedOwners = buildCheckTouchedOwnerMap(storedEntry.identity);

    // Typed identity changes (own metadata, aspect meta/tier, port aspects,
    // deterministic read-sets) — diffed against the stored typed identity.
    for (const cause of diffIdentity(nodePath, storedEntry.identity, identity)) {
      cascadeCauses.push({
        file: identityCauseToken(cause),
        layer: identityCauseLayerOf(cause),
        description: describeIdentityCause(cause),
        identity: cause,
      });
    }

    // Current files vs stored
    for (const [rawFilePath, hash] of Object.entries(fileHashes)) {
      const filePath = toPosixPath(rawFilePath);
      const storedHash = storedEntry.files[rawFilePath] ?? storedEntry.files[filePath];
      if (storedHash && storedHash === hash) continue;

      const layer = resolveLayer(filePath);
      const category = categorizeFile(filePath, graph.rootPath, projectRoot);

      if (layer === 'source') {
        directChanges.push({ filePath, category });
      } else if (layer) {
        cascadeCauses.push({
          file: filePath,
          layer,
          description: describeCascadeCause(filePath, layer, graph),
          ...(layer === 'check-touched' && checkTouchedOwners.get(filePath)
            ? { attributedAspectIds: checkTouchedOwners.get(filePath) }
            : {}),
        });
      }
    }

    // Deleted files (in stored but not in current)
    const normalizedFileHashes = new Set(Object.keys(fileHashes).map(p => toPosixPath(p)));
    for (const storedPath of Object.keys(storedEntry.files)) {
      const normalizedStored = toPosixPath(storedPath);
      if (normalizedStored in fileHashes || normalizedFileHashes.has(normalizedStored)) continue;
      // Use the POSIX-normalized path for every classification lookup AND every
      // output-bound string below — the raw key may carry host separators, which
      // must never reach the agent-visible drift report (posix-paths-output).
      const layer = resolveLayer(normalizedStored);
      const category = categorizeFile(normalizedStored, graph.rootPath, projectRoot);

      if (layer === 'source') {
        directChanges.push({ filePath: `${normalizedStored} (deleted)`, category });
      } else if (layer) {
        cascadeCauses.push({
          file: normalizedStored,
          layer,
          description: describeCascadeCause(normalizedStored, layer, graph),
        });
      } else {
        // File was in baseline but not in current tracked files -- layer unknown
        // Classify by path: .yggdrasil/ = graph, else source
        if (category === 'source') {
          directChanges.push({ filePath: `${normalizedStored} (deleted)`, category });
        } else {
          // Could be upstream file that was removed -- treat as cascade
          cascadeCauses.push({
            file: normalizedStored,
            layer: 'relational',
            description: `Tracked file removed: ${normalizedStored}`,
          });
        }
      }
    }

    // Unattributable hash divergence (baseline integrity). We are past the
    // `=== storedEntry.hash` early-return, so the recompute over this node's
    // files + typed identity + stored verdicts differs from the recorded hash —
    // yet neither a file change (directChanges) nor an identity change
    // (cascadeCauses) was found to explain it. The only remaining input to the
    // canonical fold is the stored per-aspect verdicts: a divergence with no
    // file/identity cause means the committed drift-state was hand-edited (e.g. a
    // refused->approved verdict flip leaving `hash` untouched) or predates a
    // hash-scheme change. Either way the baseline can no longer be trusted, so
    // this MUST block — never silently swallow the divergence (doing so let a
    // tampered verdict pass the gate). Both causes resolve the same way: re-approve
    // to re-establish the baseline, or restore the drift-state from git.
    if (directChanges.length === 0 && cascadeCauses.length === 0) {
      const baselineIntegrityMd = {
        what: `Recorded baseline hash for '${nodePath}' does not match a recompute over its files, identity, and verdicts.`,
        why: 'The drift-state was edited or is stale (a stored verdict may have been tampered, or the baseline predates a hash-scheme change). The recorded hash can no longer be trusted.',
        next: `yg approve --node ${nodePath} to re-establish the baseline, or restore it from git: git checkout HEAD -- .yggdrasil/.drift-state/${nodePath}.json`,
      };
      issues.push({
        severity: 'error',
        code: 'baseline-integrity',
        rule: 'baseline-integrity',
        messageData: baselineIntegrityMd,
        nodePath,
      });
      return;
    }

    // Emit source-drift for direct changes (source files changed)
    if (directChanges.length > 0) {
      const sourceFiles = directChanges.filter(f => f.category === 'source').map(f => f.filePath);

      const sourceDriftMd = {
        what: `Source files changed since last approve.\nChanged:\n${sourceFiles.map(f => '  ' + f).join('\n')}`,
        why: 'Node needs re-approval after source changes.',
        next: `yg approve --node ${nodePath}`,
      };

      issues.push({
        severity: 'error',
        code: 'source-drift',
        rule: 'source-drift',
        messageData: sourceDriftMd,
        nodePath,
        lifecycleState: 'ok',
        directChangedFiles: directChanges,
      });
    }

    // Collapse all cascade causes for this node into a single upstream-drift
    const nodeUpstreamCauses: CascadeCause[] = [];

    // Group cascade causes by logical cause (aspect ID, dep path, flow name, parent path)
    const causeGroups = new Map<string, CascadeCause[]>();
    for (const cause of cascadeCauses) {
      const key = extractCauseKey(cause);
      const group = causeGroups.get(key) ?? [];
      group.push(cause);
      causeGroups.set(key, group);
    }

    // Push all causes (causeGroups used for count accuracy via .size)
    nodeUpstreamCauses.push(...cascadeCauses);

    if (nodeUpstreamCauses.length > 0) {
      // Build a single collapsed upstream-drift for this node with all causes
      // Use causeGroups.size for the count -- reflects distinct logical upstream sources, not raw file count
      const causeCount = causeGroups.size;
      const causeLines = nodeUpstreamCauses.map((c: CascadeCause) => '  Cause: ' + c.description).join('\n');
      const upstreamDriftMd = {
        what: `Context package changed due to ${causeCount} upstream modification${causeCount === 1 ? '' : 's'}:\n${causeLines}`,
        why: 'Source may no longer satisfy updated aspect requirements.',
        next: `Load context: yg context --node ${nodePath}\nVerify source compliance, update if needed, then: yg approve --node ${nodePath}`,
      };

      issues.push({
        severity: 'error',
        code: 'upstream-drift',
        rule: 'cascade-drift',
        messageData: upstreamDriftMd,
        nodePath,
        cascadeCauses: nodeUpstreamCauses,
      });
    }
}

/**
 * Log integrity + format checks for ALL nodes (including logical / no-mapping).
 * Extracted from `classifyDrift` so the per-node drift body can be wrapped in a
 * cycle-safe try/catch without entangling log checks (which never touch the
 * implies graph). Pushes log-integrity / log-format issues into `issues`.
 */
async function classifyLogState(
  graph: Graph,
  projectRoot: string,
  issues: CheckIssue[],
): Promise<void> {
  for (const [nodePath] of graph.nodes) {
    const logRel = `.yggdrasil/model/${nodePath}/log.md`;
    const logAbs = path.join(projectRoot, logRel);
    let logContent: string | null = null;
    try {
      logContent = await readTextFile(logAbs);
    } catch { /* missing — keep null */ }

    const storedEntryForLog = await readNodeDriftState(graph.rootPath, nodePath);

    if (storedEntryForLog?.log) {
      const check = validateAppendOnly(
        logContent ?? '',
        storedEntryForLog.log.last_entry_datetime,
        storedEntryForLog.log.prefix_hash,
      );
      if (!check.ok) {
        const logIntegrityMd = {
          what: `Log integrity broken (${check.reason}) at ${logRel}${logContent === null ? ' (file missing)' : ''}`,
          why: check.reason === 'prefix_modified'
            ? 'Historical (pre-baseline) log content was modified — append-only violated.'
            : 'Baseline boundary entry not found — log was deleted or reset.',
          next: `Restore from git: git checkout HEAD -- ${logRel} .yggdrasil/.drift-state/${nodePath}.json`,
        };
        issues.push({
          severity: 'error',
          code: 'log-integrity',
          rule: 'log-integrity',
          messageData: logIntegrityMd,
          nodePath,
        });
        continue;
      }
    }

    if (logContent === null) continue;

    const violations = validateFormat(logContent);
    if (violations.length > 0) {
      const logFormatMd = {
        what: `Log format invalid at ${logRel}:\n${violations.map((v) => `  line ${v.line}: ${v.reason} — ${v.detail}`).join('\n')}`,
        why: 'Log format must be parseable for indexing and integrity.',
        next: 'Fix format violations (or git checkout) and re-run yg check.',
      };
      issues.push({
        severity: 'error',
        code: 'log-format',
        rule: 'log-format',
        messageData: logFormatMd,
        nodePath,
      });
    }
  }
}

// ── Coverage scan (unmapped-files) ────────────────────────

export {
  normalizeRoot,
  matchesRoot,
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
} from './check-coverage-tiers.js';
import { partitionByCoverageTier, buildCoverageIssue, buildCoverageAdvisoryIssue } from './check-coverage-tiers.js';

/**
 * Find git-tracked files not covered by any node mapping.
 * Accepts gitTrackedFiles as parameter for testability (CLI layer calls `git ls-files`).
 * Excludes files under the bound graph's own .yggdrasil/ and under any nested-graph
 * subtree (a directory that contains its own .yggdrasil/).
 */
export function scanUncoveredFiles(graph: Graph, gitTrackedFiles: string[]): string[] {
  // Build list of all mapping paths (normalized)
  const allMappings: string[] = [];
  for (const node of graph.nodes.values()) {
    const paths = normalizeMappingPaths(node.meta.mapping);
    allMappings.push(...paths);
  }

  // Determine .yggdrasil prefix relative to project root
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));

  const uncovered: string[] = [];

  const tracked = excludeNestedGraphSubtrees(gitTrackedFiles);
  for (const file of tracked) {
    const normalized = toPosixPath(file.trim());

    // Exclude .yggdrasil/ files
    if (normalized.startsWith(yggPrefix + '/') || normalized === yggPrefix) continue;

    // Check if covered by any mapping
    const covered = allMappings.some((mp) => mappingEntryMatchesFile(mp, normalized));

    if (!covered) {
      uncovered.push(normalized);
    }
  }

  return uncovered.sort();
}

// ── Orphaned drift state ──────────────────────────────────

/**
 * Find drift state entries for nodes that no longer exist in the graph.
 * Returns sorted list of orphaned node paths.
 */
export async function detectOrphanedDriftState(graph: Graph): Promise<string[]> {
  const driftState = await readDriftState(graph.rootPath);
  const validNodePaths = new Set(graph.nodes.keys());
  return Object.keys(driftState)
    .filter(p => !validNodePaths.has(p))
    .sort();
}

// ── Check orchestrator ────────────────────────────────────

/**
 * Run the full check: validation + drift + coverage + orphaned state.
 * @param gitTrackedFiles -- pass null to skip unmapped-files check (no git available).
 */
export async function runCheck(graph: Graph, gitTrackedFiles: string[] | null): Promise<CheckResult> {
  // 1. Validation (structural + completeness)
  const validation = await validate(graph);
  // Filter out issues without a code -- they are internal (e.g., invalid-scope).
  // All issues have a code. Convert to CheckIssue.
  const validationIssues: CheckIssue[] = validation.issues
    .filter(vi => vi.code)
    .map(vi => ({ ...vi, code: vi.code! }));

  // 2. Drift classification (source-drift/upstream-drift)
  const driftIssues = await classifyDrift(graph);

  // 3. Coverage scan (unmapped-files / uncovered-advisory)
  let coverageIssues: CheckIssue[] = [];
  let coveredFiles = 0;
  let totalFiles = 0;
  if (gitTrackedFiles !== null) {
    // Exclude .yggdrasil/ files and nested-graph subtrees from total count
    const projectRoot = path.dirname(graph.rootPath);
    const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));
    const sourceFiles = excludeNestedGraphSubtrees(gitTrackedFiles).filter(f => {
      const normalized = toPosixPath(f.trim());
      return !normalized.startsWith(yggPrefix + '/') && normalized !== yggPrefix;
    });
    totalFiles = sourceFiles.length;
    // scanUncoveredFiles applies excludeNestedGraphSubtrees internally (idempotent).
    const uncovered = scanUncoveredFiles(graph, gitTrackedFiles);
    const coverage = graph.config.coverage ?? DEFAULT_COVERAGE;
    const tiers = partitionByCoverageTier(uncovered, coverage);
    // Only required-tier errors and middle-tier warnings count against coverage%;
    // excluded files are intentionally silent and must not depress the ratio.
    coveredFiles = totalFiles - (tiers.required.length + tiers.middle.length);
    coverageIssues = [
      buildCoverageIssue(tiers.required, totalFiles),
      buildCoverageAdvisoryIssue(tiers.middle),
    ].filter((x): x is CheckIssue => x !== null);
  }

  // 4. Orphaned drift state — detect BEFORE cleanup so orphans are still visible
  const orphanedPaths = await detectOrphanedDriftState(graph);

  // 4b. Drift state cleanup: remove entries for nodes whose every effective
  // aspect resolves to draft. Runs after orphan detection so orphaned entries
  // are already captured above. Symmetric with the runGC behavior in
  // `yg approve`. Silent — no issue emitted.
  await garbageCollectDriftState(
    graph.rootPath,
    new Set(graph.nodes.keys()),
    (nodePath) => {
      const n = graph.nodes.get(nodePath);
      return n ? hasNonDraftEffectiveAspects(n, graph) : false;
    },
  );
  const yggRelative = toPosixPath(path.relative(path.dirname(graph.rootPath), graph.rootPath));
  const orphanWarnings: CheckIssue[] = orphanedPaths.map(p => {
    const orphanMd = {
      what: `Drift state file exists for '${p}' but node is no longer in the graph.`,
      why: `Orphaned file: ${yggRelative}/.drift-state/${p}.json`,
      next: `Remove the orphaned file or restore the node.`,
    };
    return {
      severity: 'warning' as const,
      code: 'orphaned-drift-state',
      rule: 'orphaned-drift-state',
      messageData: orphanMd,
      nodePath: p,
    };
  });

  // Combine all issues
  const allIssues: CheckIssue[] = [
    ...driftIssues,
    ...validationIssues,
    ...coverageIssues,
    ...orphanWarnings,
  ];

  // Node type counts
  const nodeTypeCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    const t = node.meta.type;
    nodeTypeCounts.set(t, (nodeTypeCounts.get(t) ?? 0) + 1);
  }

  const suggestedNext = computeSuggestedNext(allIssues, graph);
  // Counts aspect-status advisories only — NOT the coverage `uncovered-advisory` warning,
  // which is surfaced in the general Warnings(N) tally, not this aspect-advisory footer.
  const advisoryWarnings = allIssues.filter(i => i.code === 'aspect-violation-advisory').length;
  const draftSkipped = countDraftAspectsAcrossGraph(graph);

  return {
    projectName: path.basename(path.dirname(graph.rootPath)),
    nodeCount: graph.nodes.size,
    nodeTypeCounts,
    aspectCount: graph.aspects.length,
    flowCount: graph.flows.length,
    coveredFiles,
    totalFiles,
    issues: allIssues,
    suggestedNext,
    advisoryWarnings,
    draftSkipped,
  };
}

// ── Internal helpers ───────────────────────────────────────

/**
 * Emit per-aspect findings for one node based on the effective-status map and
 * the persisted aspectVerdicts in the baseline:
 *
 *  - non-draft status + no verdict → aspect-newly-active (error)
 *  - refused verdict + enforced status → aspect-violation-enforced (error)
 *  - refused verdict + advisory status → aspect-violation-advisory (warning)
 *
 * aspectVerdicts is always present in the typed baseline (may be `{}`).
 */
function emitPerAspectIssues(
  node: GraphNode,
  graph: Graph,
  baseline: DriftNodeState,
  issues: CheckIssue[],
): void {
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const storedVerdicts = baseline.aspectVerdicts;
  for (const [aspectId, status] of statuses) {
    if (status === 'draft') continue;
    // Aggregating aspects carry no own verdict — they only bundle implied
    // children (which appear in `statuses` on their own and are checked here).
    // Skip so a verdict-less aggregate never surfaces as aspect-newly-active.
    if (isAggregateAspect(graph, aspectId)) continue;
    const verdict = storedVerdicts[aspectId];
    if (!verdict) {
      const md = aspectNewlyActiveMessage({
        aspectId,
        nodePath: node.path,
        status: status as 'advisory' | 'enforced',
      });
      issues.push({
        severity: 'error',
        code: 'aspect-newly-active',
        rule: 'aspect-newly-active',
        messageData: md,
        nodePath: node.path,
        aspectId,
      });
      continue;
    }
    if (verdict.verdict === 'refused') {
      const reason = verdict.reason ?? '(no reason)';
      if (status === 'enforced') {
        const md = aspectViolationEnforcedMessage({ aspectId, nodePath: node.path, reason });
        issues.push({
          severity: 'error',
          code: 'aspect-violation-enforced',
          rule: 'aspect-violation-enforced',
          messageData: md,
          nodePath: node.path,
        });
      } else {
        const md = aspectViolationAdvisoryMessage({ aspectId, nodePath: node.path, reason });
        issues.push({
          severity: 'warning',
          code: 'aspect-violation-advisory',
          rule: 'aspect-violation-advisory',
          messageData: md,
          nodePath: node.path,
        });
      }
    }
  }
}

/**
 * Count UNIQUE aspect IDs whose aspect-level default status is 'draft'.
 * (Not the count of node×aspect pairs — aspects that are draft on some nodes
 * and non-draft on others are still counted once here.)
 * Surfaced as a header tally in `yg check` so the agent sees how many
 * dormant rules sit in the graph.
 */
function countDraftAspectsAcrossGraph(graph: Graph): number {
  let n = 0;
  for (const aspect of graph.aspects) {
    if ((aspect.status ?? 'enforced') === 'draft') n++;
  }
  return n;
}

/**
 * Extract a grouping key from a cascade cause so multiple changed files
 * from the same logical cause (e.g., same aspect) produce one upstream-drift issue.
 */
function extractCauseKey(cause: CascadeCause): string {
  // Group by layer + the entity identifier (aspect id, dep path, flow name, parent path)
  // Use the first path segment after the entity type directory
  return `${cause.layer}:${cause.description.split("'")[1] ?? cause.file}`;
}

/**
 * Compute mapping paths owned by descendant nodes (child-wins model).
 */
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

async function allPathsMissing(projectRoot: string, mappingPaths: string[]): Promise<boolean> {
  for (const mp of mappingPaths) {
    try {
      await fileAccess(path.join(projectRoot, mp));
      return false;
    } catch { /* missing */ }
  }
  return true;
}


/**
 * Group upstream-drift cascade issues by their upstream cause entity.
 * Returns Map<"aspect:id"|"flow:name"|"parent:path", Set<nodePath>>.
 */
function groupCascadeByCause(cascadeErrors: CheckIssue[], graph?: Graph): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const yggPrefix = graph
    ? toPosixPath(path.relative(path.dirname(graph.rootPath), graph.rootPath))
    : '.yggdrasil';
  const escPrefix = yggPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const issue of cascadeErrors) {
    if (!issue.nodePath || !issue.cascadeCauses) continue;
    for (const cause of issue.cascadeCauses) {
      const normalized = toPosixPath(cause.file);
      let key: string | null = null;

      const aspectMatch = normalized.match(new RegExp(`^${escPrefix}/aspects/([^/]+(?:/[^/]+)*)/`));
      if (aspectMatch) {
        key = `aspect:${aspectMatch[1]}`;
      }

      if (!key) {
        const modelMatch = normalized.match(new RegExp(`^${escPrefix}/model/(.+)/[^/]+$`));
        if (modelMatch) {
          key = `parent:${modelMatch[1]}`;
        }
      }

      if (key) {
        const nodes = groups.get(key) ?? new Set<string>();
        nodes.add(issue.nodePath);
        groups.set(key, nodes);
      }
    }
  }

  return groups;
}

/**
 * Suggest the next command to run based on highest-priority error.
 * Priority: drift > cascade > structural > coverage > completeness.
 */
function computeSuggestedNext(issues: CheckIssue[], graph?: Graph): string | null {
  const errors = issues.filter(i => i.severity === 'error');
  const ASPECT_STATUS_CODES = new Set([
    'aspect-newly-active',
    'aspect-violation-enforced',
    'aspect-violation-advisory',
  ]);
  if (errors.length === 0) {
    // No errors -- surface an advisory warning's `next` so the agent has a
    // suggested action when only advisory violations remain.
    const firstAspectWarning = issues.find(i =>
      i.severity === 'warning' && ASPECT_STATUS_CODES.has(i.code),
    );
    /* v8 ignore next -- tested by clean-check test, but v8 sometimes marks it uncovered */
    return firstAspectWarning?.messageData.next ?? null;
  }

  const driftErrors = errors.filter(i => i.code === 'source-drift' || i.code === 'unapproved');
  const cascadeErrors = errors.filter(i => i.code === 'upstream-drift');
  const structuralErrors = errors.filter(i => STRUCTURAL_CODES.has(i.code));
  const coverageErrors = errors.filter(i => i.code === 'unmapped-files');
  const completenessErrors = errors.filter(i => COMPLETENESS_CODES.has(i.code));

  const remaining: string[] = [];
  const addRemaining = (count: number, label: string) => { if (count > 0) remaining.push(`${count} ${label}`); };

  if (driftErrors.length > 0) {
    const node = driftErrors[0].nodePath!;
    addRemaining(cascadeErrors.length, 'cascade reviews');
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `yg context --node ${node}\n  1 of ${driftErrors.length} drifted node${driftErrors.length === 1 ? '' : 's'} — post-modify workflow${then}`;
  }

  const logIntegrityErrors = errors.filter((i) => i.code === 'log-integrity');
  const logFormatErrors = errors.filter((i) => i.code === 'log-format');

  if (logIntegrityErrors.length > 0) {
    const node = logIntegrityErrors[0].nodePath ?? '<unknown>';
    return `git checkout HEAD -- .yggdrasil/model/${node}/log.md .yggdrasil/.drift-state/${node}.json\n  ${logIntegrityErrors.length} log integrity violation${logIntegrityErrors.length === 1 ? '' : 's'} — restore from git`;
  }

  if (logFormatErrors.length > 0) {
    const node = logFormatErrors[0].nodePath ?? '<unknown>';
    return `Edit .yggdrasil/model/${node}/log.md to fix format violations\n  ${logFormatErrors.length} log format violation${logFormatErrors.length === 1 ? '' : 's'} — post-baseline edit OR git checkout for pre-baseline`;
  }

  if (cascadeErrors.length > 0) {
    const entityGroups = groupCascadeByCause(cascadeErrors, graph);

    // Find the largest group with >=2 nodes
    let bestEntity: { type: string; id: string; count: number } | null = null;
    for (const [key, nodes] of entityGroups) {
      if (nodes.size >= 2 && (!bestEntity || nodes.size > bestEntity.count)) {
        const [type, id] = key.split(':', 2);
        bestEntity = { type, id, count: nodes.size };
      }
    }

    if (bestEntity) {
      const flagMap: Record<string, string> = {
        aspect: '--aspect',
        parent: '--node',
      };
      const flag = flagMap[bestEntity.type] ?? '--aspect';
      addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
      const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
      return `yg approve ${flag} ${bestEntity.id}\n  ${bestEntity.count} cascade node${bestEntity.count === 1 ? '' : 's'} from ${bestEntity.type} change${then}`;
    }

    // Single cascade node — fall through to original behavior
    const node = cascadeErrors[0].nodePath!;
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `yg context --node ${node}\n  1 of ${cascadeErrors.length} cascade node${cascadeErrors.length === 1 ? '' : 's'} — cascade review${then}`;
  }

  if (structuralErrors.length > 0) {
    const first = structuralErrors[0];
    addRemaining(coverageErrors.length > 0 ? (coverageErrors[0].uncoveredCount ?? 0) : 0, 'files need coverage');
    const then = remaining.length > 0 ? `\n  Then: ${remaining.join(', ')}` : '';
    return `Fix ${first.code} in ${first.nodePath ?? '.yggdrasil/'}\n  1 of ${structuralErrors.length} structural error${structuralErrors.length === 1 ? '' : 's'}${then}`;
  }

  if (coverageErrors.length > 0) {
    const count = coverageErrors[0].uncoveredCount ?? 0;
    return `yg context --file <uncovered-path>\n  ${count} file${count === 1 ? '' : 's'} need coverage — bootstrap workflow`;
  }

  if (completenessErrors.length > 0) {
    const first = completenessErrors[0];
    return `Fix ${first.code} for ${first.nodePath}\n  1 of ${completenessErrors.length} completeness error${completenessErrors.length === 1 ? '' : 's'} — post-modify workflow`;
  }

  // Aspect-status emissions (aspect-newly-active, aspect-violation-enforced,
  // aspect-violation-advisory) carry their own `next` directly inside
  // messageData. Prefer an error's `next` over a warning's so an enforced
  // violation outranks a co-emitted advisory warning.
  const firstAspectError = issues.find(i =>
    i.severity === 'error' && ASPECT_STATUS_CODES.has(i.code),
  );
  if (firstAspectError) return firstAspectError.messageData.next;
  const firstAspectWarning = issues.find(i =>
    i.severity === 'warning' && ASPECT_STATUS_CODES.has(i.code),
  );
  if (firstAspectWarning) return firstAspectWarning.messageData.next;

  return null;
}
