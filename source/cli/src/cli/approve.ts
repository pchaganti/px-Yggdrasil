import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../formatters/cli-preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { approveNode, evaluateAllDraftLogGate, resolveAspects, loadSourceFiles } from '../core/approve.js';
import { runApproveWithReviewer, type LlmApproveResult } from '../core/approve-reviewer.js';
export type { LlmApproveResult };
import { collectTrackedFiles, tierIdentityKey, checkTouchedKey, aspectMetaKey, yggPrefixOf } from '../core/graph/files.js';
import { collectParticipatingFlows } from '../core/graph/flows.js';
import { hashTrackedFiles } from '../io/hash.js';
import { classifyDrift } from '../core/check.js';
import type { CheckIssue, CascadeCause } from '../core/check.js';
import { validate } from '../core/validator.js';
import { normalizeMappingPaths } from '../io/paths.js';
import type { ApproveResult, DriftNodeState } from '../model/drift.js';
import type { Graph, LlmConfig } from '../model/graph.js';
import { readNodeDriftState } from '../io/drift-state-store.js';
import { runStructureAspect } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses, getAspectStatusSources, hasNonDraftEffectiveAspects } from '../core/graph/aspects.js';
import { toPosix, toPosixPath } from '../utils/posix.js';
import {
  approveAspectDraftScenarioAMessage,
  approveAspectDraftScenarioBMessage,
  approveNodeAllDraftMessage,
} from '../formatters/aspect-status-messages.js';

export async function runLlmVerification(
  graph: Graph,
  nodePath: string,
  result: ApproveResult,
  secretsByProvider: Map<string, Partial<LlmConfig> | null>,
  filterAspectId?: string,
): Promise<LlmApproveResult> {
  // Read prior baseline to thread its per-aspect verdicts through. Used by the
  // reviewer to preserve untouched aspects' verdicts in filter-aspect runs.
  const storedEntry = await readNodeDriftState(graph.rootPath, nodePath);
  // Option 1: on an approve where filterAspectId is undefined (--node, --flow
  // cascade, parent-redirect), restrict the reviewer dispatch to the drifted
  // subset and carry the rest forward. yggPrefixOf is the shared derivation also
  // used by approveNode, so the `aspects/<id>/` prefix lines up byte-identically
  // with the changedUpstream filePaths.
  const yggPrefix = yggPrefixOf(graph);
  const reReviewAspectIds = filterAspectId
    ? undefined
    : selectDriftedAspects(graph, nodePath, result, storedEntry, yggPrefix);
  return runApproveWithReviewer({
    graph,
    nodePath,
    result,
    rootPath: graph.rootPath,
    filterAspectId,
    secretsByProvider,
    storedEntry,
    reReviewAspectIds,
  });
}

// ── Output formatting ────────────────────────────────────────


export function formatResult(nodePath: string, result: LlmApproveResult): void {
  switch (result.action) {
    case 'approved': {
      const aspectCount = result.aspectResults ? Object.keys(result.aspectResults).length : 0;
      const suffix = aspectCount > 0 ? ` — ${aspectCount} aspects satisfied.` : '';
      process.stdout.write(chalk.green(`Approved: ${nodePath}${suffix}\n`));
      break;
    }

    case 'initial':
      process.stdout.write(chalk.green(`Approved: ${nodePath} (initial)\n`));
      break;

    case 'no-change':
      process.stdout.write(`No changes: ${nodePath}\n`);
      break;

    case 'refused':
      formatRefused(nodePath, result);
      break;
  }

  formatLlmResults(result);
  formatAdvisoryViolations(nodePath, result);

  // Report GC'd orphaned drift state
  if (result.gcPaths && result.gcPaths.length > 0) {
    for (const p of result.gcPaths) {
      process.stdout.write(chalk.dim(`Removed orphaned drift state: ${p}\n`));
    }
  }
}

function formatLlmResults(result: LlmApproveResult): void {
  if (result.llmSkipped) {
    const messages: Record<NonNullable<LlmApproveResult['llmSkipped']>, { what: string; why: string; next: string }> = {
      'unavailable': {
        what: 'The configured reviewer could not be contacted, so LLM aspects were not verified.',
        why: 'Approval fails closed when an LLM aspect cannot be verified: NO baseline was recorded and the prior drift stays visible, so a later yg check remains red rather than going green over unverified code.',
        next: 'Check the reviewer provider and credentials in .yggdrasil/yg-config.yaml, then re-run yg approve.',
      },
    };
    process.stdout.write(chalk.yellow(buildIssueMessage(messages[result.llmSkipped]) + '\n'));
    return;
  }

  if (result.aspectResults) {
    // Advisory-only code violations are NOT rendered as red "NOT SATISFIED"
    // here — they are surfaced as an informational line by
    // formatAdvisoryViolations. Excluding them keeps this block reserved for
    // blocking (enforced / infra) failures on a refused node.
    const advisoryIds = new Set((result.advisoryViolations ?? []).map(v => v.aspectId));
    const entries = Object.entries(result.aspectResults);
    const unsatisfied = entries.filter(([id, r]) => !r.satisfied && !advisoryIds.has(id));
    if (unsatisfied.length === 0) {
      // All satisfied (or only advisory) — summary already printed by formatResult
      return;
    }
    process.stdout.write('\nAspect verification:\n');
    for (const [aspectId, aspectResult] of entries) {
      if (advisoryIds.has(aspectId)) continue;
      if (aspectResult.satisfied) {
        process.stdout.write(chalk.green(`  ${aspectId} — SATISFIED\n`));
      } else {
        process.stdout.write(chalk.red(`  ${aspectId} — NOT SATISFIED\n`));
        process.stdout.write(`    ${aspectResult.reason}\n`);
      }
    }
  }

}

/**
 * Print advisory-only code violations as an informational line. These do NOT
 * refuse the node (the action is approved/initial/no-change) and do NOT affect
 * the exit code — advisory aspects warn but do not block. `yg check` continues
 * to render them as non-blocking warnings from the recorded baseline verdict.
 */
function formatAdvisoryViolations(nodePath: string, result: LlmApproveResult): void {
  const advisory = result.advisoryViolations ?? [];
  if (advisory.length === 0) return;
  process.stdout.write(chalk.yellow(buildIssueMessage({
    what: `${advisory.length} advisory aspect violation(s) on ${nodePath} — recorded, not blocking: ${advisory.map(v => v.aspectId).join(', ')}.`,
    why: 'Advisory aspects warn but do not block approval or CI; their refused verdicts are recorded in the baseline and surfaced by yg check as non-blocking warnings.',
    next: 'Review each recorded reason below and fix the violation, or keep the aspect advisory. To see them again later, run yg check.',
  }) + '\n'));
  for (const v of advisory) {
    process.stdout.write(chalk.dim(`    ${v.aspectId}: ${v.reason}\n`));
  }
}

function formatRefused(nodePath: string, result: LlmApproveResult): void {
  // LLM reviewer refused — details printed by formatLlmResults
  if (result.aspectViolations && result.aspectViolations.length > 0) {
    process.stderr.write(chalk.red(buildIssueMessage({
      what: 'Reviewer found aspect violations.',
      why: 'One or more aspects listed above were not satisfied by the source code.',
      next: `Fix the violations and re-run: yg approve --node ${nodePath}`,
    }) + '\n'));
    return;
  }

  // Fallback
  process.stderr.write(
    chalk.red(
      `Error: ${buildIssueMessage(result.refuseReasonData ?? {
        what: 'Approve refused.',
        why: 'The reviewer rejected this node but did not return a structured reason.',
        next: 'Re-run with YG_DEBUG_LLM=1 to capture the raw reviewer transcript.',
      })}\n`,
    ),
  );
}

// ── Batch types and execution ─────────────────────────────────

export interface BatchResult {
  nodePath: string;
  result: LlmApproveResult;
  /** Convenience mirror of result.skippedDraftAspects for footer tally. */
  skippedDraftAspects: string[];
}

/**
 * Worker-pool semaphore: runs approveOne on each node with at most
 * `concurrency` concurrent operations. Returns results in input order.
 */
export async function runBatch(
  nodes: string[],
  concurrency: number,
  approveOne: (nodePath: string) => Promise<LlmApproveResult>,
): Promise<BatchResult[]> {
  const results: BatchResult[] = new Array(nodes.length);
  const queue = [...nodes.entries()]; // [[0, 'path0'], [1, 'path1'], ...]
  const workers = Array.from({ length: Math.min(concurrency, nodes.length) }, async () => {
    while (true) {
      const item = queue.shift(); // atomic in JS single-threaded event loop
      if (!item) break;
      const [i, nodePath] = item;
      try {
        const result = await approveOne(nodePath);
        results[i] = {
          nodePath,
          result,
          skippedDraftAspects: result.skippedDraftAspects ?? [],
        };
      } catch (err) {
        // Contract: one node's failure must NOT abort the others. An
        // unexpected throw (e.g. a filesystem error) is recorded as a
        // synthetic refused result so the batch completes, every node is
        // reported, and the failure counts toward the exit code.
        const message = err instanceof Error ? err.message : String(err);
        debugWrite(`[approve] batch worker threw for ${nodePath}: ${message}`);
        results[i] = {
          nodePath,
          result: {
            action: 'refused',
            currentHash: '',
            refuseReasonData: {
              what: `Approve crashed for ${nodePath}.`,
              why: message,
              next: `Investigate the error above, then re-run: yg approve --node ${nodePath}`,
            },
          },
          skippedDraftAspects: [],
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Filter upstream-drift cascade issues by cause prefix.
 * Returns node paths whose cascadeCauses include files under the given prefix.
 */
export function filterCascadeNodes(
  issues: CheckIssue[],
  causePrefix: string,
): string[] {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath || !issue.cascadeCauses) continue;
    const hasMatchingCause = issue.cascadeCauses.some(
      (c: CascadeCause) => toPosix(c.file).startsWith(causePrefix),
    );
    if (hasMatchingCause) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
}

/**
 * Select nodes for `yg approve --flow <name>`: nodes that have cascade
 * (upstream) drift AND participate in the flow. Unlike `filterCascadeNodes`,
 * this does NOT match on a cause-file prefix — a flow-attached aspect's change
 * is recorded under `aspects/<id>/`, never `flows/<name>/`, so a path-prefix
 * filter misses every participant. Flow participation follows the
 * descendant-inclusion rule via `collectParticipatingFlows` (a node
 * participates when it or any ancestor is a declared participant).
 */
export function filterFlowCascadeNodes(
  issues: CheckIssue[],
  graph: Graph,
  flowName: string,
): string[] {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath) continue;
    const node = graph.nodes.get(issue.nodePath);
    if (!node) continue;
    if (collectParticipatingFlows(graph, node).some(f => f.path === flowName)) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
}

/**
 * Select nodes for `yg approve --aspect <id>`: nodes with cascade drift caused
 * by this aspect. Not every cause for an aspect lives under `aspects/<id>/` —
 * an aspect's declared reference files are tracked at their own repo path, and
 * the per-aspect drift identities are synthetic keys (see collectTrackedFiles).
 * A plain `aspects/<id>/` prefix filter misses all of those, so a node that
 * drifted only because the aspect's reference file (or the tier-identity / the
 * check-touched set) changed would be silently skipped. Match the prefix OR
 * any of those.
 */
/**
 * Single source of truth for the drift-cause paths attributable to one aspect:
 * its `aspects/<id>/` prefix plus the synthetic identity keys and reference-file
 * paths that `collectTrackedFiles` emits for it. The synthetic keys come from the
 * key-builders in core/graph/files.js (the producers), so this stays in lockstep
 * with how the keys are written into baselines. Both cascade-attribution helpers
 * below (filterAspectCascadeNodes, selectDriftedAspects) match a cause path with
 * `file.startsWith(prefix) || keys.has(file)`.
 *
 * When given the node's `checkTouchedFiles` (the baseline's per-aspect map of
 * actual cross-node paths a graph-aware deterministic aspect read), the keys also
 * include those raw paths for this aspect. A change to one of them then resolves to
 * the owning deterministic aspect instead of being un-attributable and forcing a
 * node-global re-run. Omit the argument to keep the synthetic-key-only behavior.
 */
function aspectDependencyKeys(
  aspectId: string,
  yggPrefix: string,
  graph: Graph,
  checkTouchedFiles?: Record<string, Record<string, string>>,
): { prefix: string; keys: Set<string> } {
  const aspect = graph.aspects.find(a => a.id === aspectId);
  const touched = checkTouchedFiles?.[aspectId];
  return {
    prefix: `${yggPrefix}/aspects/${aspectId}/`,
    keys: new Set<string>([
      tierIdentityKey(aspectId),
      checkTouchedKey(aspectId),
      aspectMetaKey(aspectId),
      ...(aspect?.references ?? []).map(r => toPosix(r.path)),
      ...(touched ? Object.keys(touched).map(p => toPosix(p)) : []),
    ]),
  };
}

export async function filterAspectCascadeNodes(
  issues: CheckIssue[],
  graph: Graph,
  aspectId: string,
  yggPrefix: string,
): Promise<string[]> {
  const matched: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'upstream-drift' || !issue.nodePath || !issue.cascadeCauses) continue;
    // Attribute cross-node check-touched paths by consulting THIS
    // node's stored baseline: the raw file path a graph-aware deterministic
    // aspect read (not a synthetic key) only resolves to its owning aspect via
    // the baseline's per-aspect checkTouchedFiles map. A missing or
    // corrupt baseline reads as undefined → fall back to the synthetic-key /
    // prefix match only (never crash, never exclude a prefix/key hit).
    const storedEntry = await readNodeDriftState(graph.rootPath, issue.nodePath);
    const { prefix, keys } = aspectDependencyKeys(
      aspectId,
      yggPrefix,
      graph,
      storedEntry?.checkTouchedFiles,
    );
    const hit = issue.cascadeCauses.some((c: CascadeCause) => {
      const f = toPosix(c.file);
      return f.startsWith(prefix) || keys.has(f);
    });
    if (hit) matched.push(issue.nodePath);
  }
  return matched;
}

/**
 * Option 1: choose which effective non-draft aspects must be re-verified on an
 * approve where filterAspectId is undefined (--node, --flow cascade, parent-redirect).
 * Returns the subset of aspect ids to re-run, or `undefined` to re-run ALL
 * (node-global drift, or back-compat baseline without per-aspect verdicts).
 * Conservative: any source change, or any upstream change not attributable to a
 * specific aspect, forces a full re-run.
 */
export function selectDriftedAspects(
  graph: Graph,
  nodePath: string,
  result: ApproveResult,
  storedEntry: DriftNodeState | undefined,
  yggPrefix: string,
): Set<string> | undefined {
  if (!storedEntry?.aspectVerdicts) return undefined;
  if (result.changedSource && result.changedSource.length > 0) return undefined;

  const node = graph.nodes.get(nodePath);
  if (!node) return undefined;
  const effective = computeEffectiveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);

  const subset = new Set<string>();
  for (const change of result.changedUpstream ?? []) {
    const file = toPosix(change.filePath);
    const owners: string[] = [];
    for (const id of effective) {
      if (statuses.get(id) === 'draft') continue;
      const { prefix, keys } = aspectDependencyKeys(id, yggPrefix, graph, storedEntry.checkTouchedFiles);
      if (file.startsWith(prefix) || keys.has(file)) owners.push(id);
    }
    if (owners.length === 0) return undefined; // un-attributable upstream → node-global
    for (const id of owners) subset.add(id);
  }

  // Always re-run newly-attached aspects (effective + non-draft, no prior verdict
  // to carry forward — carry-forward only restores when a prior exists).
  for (const id of effective) {
    if (statuses.get(id) === 'draft') continue;
    if (!storedEntry.aspectVerdicts[id]) subset.add(id);
  }
  return subset;
}

export function formatBatchOutput(results: BatchResult[], scenarioBSkips: string[] = []): void {
  let approved = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const { nodePath, result } = results[i];
    if (results.length > 1) {
      process.stdout.write(`\n${'─'.repeat(3)} ${nodePath} ${'─'.repeat(Math.max(1, 50 - nodePath.length))}\n\n`);
    }
    formatResult(nodePath, result);
    if (result.action === 'refused') failed++;
    else approved++;
  }

  const skippedDraftCount = results.reduce((n, b) => n + b.skippedDraftAspects.length, 0)
    + scenarioBSkips.length;
  if (skippedDraftCount > 0) {
    process.stdout.write(`\n${approved} approved, ${failed} failed, ${skippedDraftCount} skipped (draft).\n`);
  } else {
    process.stdout.write(`\n${approved} approved, ${failed} failed.\n`);
  }
}

// ── Dry-run per-node helper ───────────────────────────────────

/**
 * Dry-run preview for a single node. Prints what the reviewer WOULD see
 * without invoking it. Each LLM aspect prompt is tagged with the aspect's
 * effective status on this node — `[draft]` aspects also get a clarifying
 * annotation since real approve would skip them.
 */
export async function runDryRunForNode(params: {
  graph: Graph;
  nodePath: string;
  yggPrefix: string;
}): Promise<boolean> {
  const { graph, nodePath, yggPrefix } = params;
  const node = graph.nodes.get(nodePath);
  if (!node) {
    process.stderr.write(
      chalk.red(
        `Error: ${buildIssueMessage({
          what: `Node '${nodePath}' not found.`,
          why: 'The path does not match any node in the loaded graph.',
          next: "Run 'yg tree' to list all nodes; verify the path and re-run.",
        })}\n`,
      ),
    );
    return false;
  }

  const { buildPrompt } = await import('../llm/aspect-verifier.js');
  const aspects = resolveAspects(node, graph);
  const statuses = computeEffectiveAspectStatuses(node, graph);
  const projectRoot = path.dirname(graph.rootPath);
  const trackedFiles = collectTrackedFiles(node, graph);
  const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
  const sourceFilePaths = Object.keys(fileHashes).filter(f => {
    const normalized = toPosixPath(f);
    return !normalized.startsWith(yggPrefix);
  });
  const sourceFiles = await loadSourceFiles(sourceFilePaths, projectRoot);
  process.stdout.write(chalk.bold(`\n--- Dry run: ${nodePath} ---\n\n`));
  process.stdout.write(`Aspects (${aspects.length}): ${aspects.map(a => a.id).join(', ') || 'none'}\n`);
  process.stdout.write(`Source files (${sourceFiles.length}): ${sourceFiles.map(f => f.path).join(', ') || 'none'}\n\n`);

  // Deterministic aspects run locally through the structure runner (no LLM
  // call). The preview routes through runStructureAspect so it cannot diverge
  // from the verdict real approve produces (the documented preview-equals-verdict
  // invariant).
  const deterministicAspects = aspects.filter(a => a.reviewer?.type === 'deterministic');
  const llmAspects = aspects.filter(a => a.reviewer?.type === 'llm');

  const astParseCache = new Map();
  const previewDeterministic = async (aspect: typeof aspects[number]): Promise<void> => {
    const status = statuses.get(aspect.id) ?? 'enforced';
    process.stdout.write(chalk.bold(`\n--- Deterministic aspect: ${aspect.id} [${status}] ---\n\n`));
    if (status === 'draft') {
      process.stdout.write(chalk.dim('(real approve would skip — preview only)\n\n'));
    }
    try {
      const structResult = await runStructureAspect({
        aspectDir: path.join('.yggdrasil/aspects', aspect.id),
        aspectId: aspect.id,
        nodePath,
        graph,
        projectRoot,
        parseCache: astParseCache,
      });
      if (structResult.violations.length === 0) {
        process.stdout.write('  no violations\n');
      } else {
        for (const v of structResult.violations) {
          const loc = v.file ? `${v.file}:${v.line ?? '?'}: ` : '';
          process.stdout.write(`  ${loc}${v.message}\n`);
        }
      }
    } catch (e: unknown) {
      debugWrite(`[approve] dry-run deterministic aspect ${aspect.id}: ${e instanceof Error ? e.message : String(e)}`);
      process.stderr.write(chalk.red(buildIssueMessage({
        what: `Deterministic aspect '${aspect.id}' runner failed.`,
        why: (e as Error).message,
        next: 'Verify the aspect check.mjs is valid and that the node declares relations for any graph or filesystem reads it performs.',
      }) + '\n'));
    }
  };

  // Deterministic aspects — routed through the structure runner (preview = verdict).
  for (const aspect of deterministicAspects) {
    await previewDeterministic(aspect);
  }

  // LLM aspects — show prompt for each (with references loaded for parity with real run)
  if (llmAspects.length > 0 && sourceFiles.length > 0) {
    const { loadAndIsolateReferences } = await import('../core/approve-reviewer.js');
    const { readTextFile } = await import('../io/graph-fs.js');
    const refsCache = new Map<string, string>();
    for (const aspect of llmAspects) {
      const status = statuses.get(aspect.id) ?? 'enforced';
      const loaded = await loadAndIsolateReferences({
        aspectId: aspect.id,
        references: aspect.references,
        projectRoot,
        cache: refsCache,
        readTextFile,
      });
      const references = loaded.ok ? loaded.references : [];
      if (!loaded.ok) {
        process.stdout.write(chalk.yellow(buildIssueMessage({
          what: `Reference file failed to load for LLM aspect '${aspect.id}' during dry-run: ${loaded.reason}`,
          why: 'The dry-run preview omits this reference, so the prompt shown here will not match what a real approve would send once the reference loads.',
          next: `Fix the reference path or file declared on aspect '${aspect.id}', then re-run the dry-run.`,
        }) + '\n'));
      }
      const prompt = buildPrompt(aspect, node.meta.description ?? '', nodePath, sourceFiles, references);
      process.stdout.write(chalk.bold(`\n--- Prompt for LLM aspect: ${aspect.id} [${status}] ---\n`));
      if (status === 'draft') {
        process.stdout.write(chalk.dim('(real approve would skip — preview only)\n'));
      }
      process.stdout.write(prompt + '\n');
    }
  }
  return true;
}

// ── Gating codes — approve must not invoke LLM when these are present ──

export const APPROVE_GATING_CODES = new Set([
  'config-reviewer-legacy-format',
  'config-reviewer-mixed-format',
  'config-reviewer-missing',
  'config-tiers-missing',
  'config-tiers-empty',
  'config-default-tier-missing',
  'config-default-tier-unknown',
  'config-tier-provider-missing',
  'config-tier-provider-unknown',
  'config-tier-config-missing',
  'config-tier-config-not-mapping',
  'config-tier-consensus-invalid',
  'config-tier-name-invalid',
  'config-tier-name-reserved',
  'config-reviewer-unknown-key',
  'config-tier-unknown-key',
  'aspect-reviewer-legacy-string',
  'aspect-reviewer-missing',
  'aspect-reviewer-not-mapping',
  'aspect-reviewer-type-missing',
  'aspect-reviewer-type-invalid',
  'aspect-reviewer-unknown-key',
  'aspect-tier-on-deterministic',
  'aspect-tier-unknown',
  'secrets-non-credential-field',
]);

async function abortOnGatingErrors(graph: Graph): Promise<void> {
  const validationResult = await validate(graph);
  const gating = validationResult.issues.filter(i => i.code !== undefined && APPROVE_GATING_CODES.has(i.code));
  if (gating.length > 0) {
    const issueDetails = gating.map(i => buildIssueMessage(i.messageData)).join('\n\n');
    process.stderr.write(chalk.red(buildIssueMessage({
      what: 'yg approve aborted — configuration errors block tier resolution.',
      why: issueDetails,
      next: 'Fix the errors above, then re-run: yg approve',
    }) + '\n\n'));
    process.exit(1);
  }
}

// ── Batch approve orchestrator ───────────────────────────────

async function runBatchApprove(
  graph: Graph,
  entityLabel: string,
  selectNodes: (issues: CheckIssue[]) => string[] | Promise<string[]>,
  filterAspectId?: string,
): Promise<boolean> {
  const issues = await classifyDrift(graph);
  const matchedNodes = await selectNodes(issues);

  if (matchedNodes.length === 0) {
    process.stdout.write(`No cascade drift found for ${entityLabel}.\n`);
    return true;
  }

  await abortOnGatingErrors(graph);

  const parallel = graph.config.parallel ?? 1;
  const sorted = matchedNodes.sort();

  if (parallel > 1) {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel} (parallel: ${parallel})...\n\n`);
  } else {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel}...\n`);
  }

  const secretsByProvider = new Map<string, Partial<LlmConfig> | null>();
  // Scenario B tally — per-node skip when the filtered aspect resolves to draft
  // on this node (every cascading channel overrides it down).
  const scenarioBSkips: string[] = [];

  const results = await runBatch(sorted, parallel, async (nodePath) => {
    // Scenario B: if --aspect X was passed and X resolves to draft on this
    // specific node, emit a friendly per-node message and skip the reviewer
    // without touching baseline. Other nodes continue normally.
    if (filterAspectId) {
      const node = graph.nodes.get(nodePath);
      if (node) {
        const statuses = computeEffectiveAspectStatuses(node, graph);
        if (statuses.get(filterAspectId) === 'draft') {
          const sources = getAspectStatusSources(node, filterAspectId, graph);
          const draftSource = sources.find(s => s.declared === 'draft');
          const origin = draftSource?.origin ?? 'attach-site override';
          process.stdout.write(buildIssueMessage(approveAspectDraftScenarioBMessage({
            aspectId: filterAspectId,
            nodePath,
            origin,
          })) + '\n');
          scenarioBSkips.push(`${filterAspectId}@${nodePath}`);
          return {
            action: 'no-change' as const,
            currentHash: '',
            skippedDraftAspects: [filterAspectId],
          };
        }
      }
    }
    const result = await approveNode(graph, nodePath);
    return runLlmVerification(graph, nodePath, result, secretsByProvider, filterAspectId);
  });

  formatBatchOutput(results, scenarioBSkips);
  return results.every(r => r.result.action !== 'refused');
}

// ── Command registration ─────────────────────────────────────

export function registerApproveCommand(program: Command): void {
  // `yg approve` — primary command
  program
    .command('approve')
    .description('Approve a node\'s current state, recording it as the new baseline')
    .option('--node <paths...>', 'One or more node paths to approve')
    .option('--aspect <id>', 'Batch approve all nodes with cascade drift from this aspect')
    .option('--flow <name>', 'Batch approve all nodes with cascade drift from this flow')
    .option('--dry-run', 'Show what would be sent to the reviewer without sending it')
    .action(async (options: { node?: string[]; aspect?: string; flow?: string; dryRun?: boolean }) => {
      try {
        // Validate: exactly one of --node, --aspect, --flow
        const targets = [options.node, options.aspect, options.flow].filter(Boolean);
        if (targets.length === 0) {
          process.stderr.write(
            chalk.red(
              `Error: ${buildIssueMessage({
                what: 'No target specified.',
                why: 'yg approve needs exactly one of --node, --aspect, or --flow.',
                next: 'Pass --node <path> (repeatable), --aspect <id>, or --flow <name>.',
              })}\n`,
            ),
          );
          process.exit(1);
        }
        if (targets.length > 1) {
          process.stderr.write(
            chalk.red(
              `Error: ${buildIssueMessage({
                what: 'Multiple targets specified.',
                why: 'yg approve accepts only one of --node, --aspect, or --flow per invocation.',
                next: 'Re-run with a single target form.',
              })}\n`,
            ),
          );
          process.exit(1);
        }

        // --dry-run is a single-node preview only. A batch target (--aspect /
        // --flow) has no preview mode; silently honoring --dry-run here would
        // either do nothing or fall through to a REAL batch approval, so reject
        // it before either batch branch dispatches.
        if (options.dryRun && (options.aspect || options.flow)) {
          process.stderr.write(chalk.red(buildIssueMessage({
            what: '--dry-run is only supported with --node, not with --aspect or --flow.',
            why: 'A batch approve (--aspect / --flow) commits real verdicts to every affected node; there is no preview mode for it, so honoring --dry-run silently would either do nothing or perform a real approval.',
            next: 'Preview a single node with: yg approve --node <path> --dry-run. To run the batch for real, drop --dry-run.',
          })) + '\n');
          process.exit(1);
          return;
        }

        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const yggPrefix = toPosixPath(path.relative(path.dirname(graph.rootPath), graph.rootPath));

        // --dry-run: show what would be sent to the reviewer
        if (options.dryRun && options.node) {
          let allFound = true;
          for (const rawPath of options.node) {
            const nodePath = rawPath.trim().replace(/\/$/, '');
            const found = await runDryRunForNode({ graph, nodePath, yggPrefix });
            if (!found) allFound = false;
          }
          process.exit(allFound ? 0 : 1);
        }

        // --aspect: batch approve all nodes with cascade drift from this aspect
        if (options.aspect) {
          const aspectId = options.aspect.trim();
          const aspectDef = graph.aspects.find(a => a.id === aspectId);
          if (!aspectDef) {
            process.stderr.write(chalk.red(buildIssueMessage({
              what: `Aspect '${aspectId}' does not exist.`,
              why: 'The aspect id must match a directory name under .yggdrasil/aspects/.',
              next: 'Run: yg aspects — to list all defined aspects.',
            }) + '\n'));
            process.exit(1);
          }
          // Scenario A: aspect-default status is 'draft'. No node could raise
          // it via cascade (draft is the lattice floor for unset overrides),
          // so the entire batch is a no-op. Exit 0 with a friendly message.
          if (aspectDef.status === 'draft') {
            process.stdout.write(buildIssueMessage(approveAspectDraftScenarioAMessage({ aspectId })) + '\n');
            process.exit(0);
          }
          const allPassed = await runBatchApprove(graph, `aspect '${aspectId}'`, (issues) => filterAspectCascadeNodes(issues, graph, aspectId, yggPrefix), aspectId);
          process.exit(allPassed ? 0 : 1);
        }

        // --flow: batch approve all nodes with cascade drift from this flow
        if (options.flow) {
          const flowName = options.flow.trim();
          const flowExists = graph.flows.some(f => f.path === flowName);
          if (!flowExists) {
            process.stderr.write(chalk.red(buildIssueMessage({
              what: `Flow '${flowName}' does not exist.`,
              why: 'The flow name must match a directory name under .yggdrasil/flows/.',
              next: 'Run: yg flows — to list all defined flows.',
            }) + '\n'));
            process.exit(1);
          }
          const allPassed = await runBatchApprove(graph, `flow '${flowName}'`, (issues) => filterFlowCascadeNodes(issues, graph, flowName));
          process.exit(allPassed ? 0 : 1);
        }

        // --node: multi-node batch or single node
        if (options.node && options.node.length > 1) {
          await abortOnGatingErrors(graph);
          const parallel = graph.config.parallel ?? 1;
          const nodePaths = options.node.map(n => n.trim().replace(/\/$/, ''));
          if (parallel > 1) {
            process.stdout.write(`Approving ${nodePaths.length} nodes (parallel: ${parallel})...\n\n`);
          } else {
            process.stdout.write(`Approving ${nodePaths.length} nodes...\n`);
          }
          const secretsByProvider = new Map<string, Partial<LlmConfig> | null>();
          const batchResults = await runBatch(nodePaths, parallel, async (nodePath) => {
            const result = await approveNode(graph, nodePath);
            return runLlmVerification(graph, nodePath, result, secretsByProvider);
          });
          formatBatchOutput(batchResults);
          const anyFailed = batchResults.some(r => r.result.action === 'refused');
          if (anyFailed) process.exit(1);
          return;
        }

        // Single node
        const nodePath = options.node![0].trim().replace(/\/$/, '');

        // No-mapping parent redirect to batch
        const node = graph.nodes.get(nodePath);
        if (!node) {
          process.stderr.write(
            chalk.red(
              `Error: ${buildIssueMessage({
                what: `Node '${nodePath}' does not exist.`,
                why: 'The given path does not match any node in the loaded graph.',
                next: "Run 'yg tree' to list all nodes; verify the path and re-run.",
              })}\n`,
            ),
          );
          process.exit(1);
        }

        const mappingPaths = normalizeMappingPaths(node.meta.mapping);
        if (mappingPaths.length === 0) {
          const causePrefix = `${yggPrefix}/model/${nodePath}/`;
          const allPassed = await runBatchApprove(graph, `parent node '${nodePath}'`, (issues) => filterCascadeNodes(issues, causePrefix));
          process.exit(allPassed ? 0 : 1);
        }

        // Has mapping — single node approve
        await abortOnGatingErrors(graph);

        // All-draft node: every effective aspect is draft → reviewer skipped, no
        // baseline written, no drift tracked. But the mandatory-log gate is NOT
        // skipped — a source change on a log_required node still demands an entry,
        // independent of aspect status. Run the gate-only check (which does NOT GC
        // or rewrite the baseline, so a prior baseline's carry-forward survives a
        // draft toggle) and honor a refusal; only on a clean pass emit the notice.
        if (!hasNonDraftEffectiveAspects(node, graph)) {
          const gate = await evaluateAllDraftLogGate(graph, nodePath);
          if (gate?.action === 'refused') {
            formatResult(nodePath, gate);
            process.exit(1);
          }
          process.stdout.write(buildIssueMessage(approveNodeAllDraftMessage({ nodePath })) + '\n');
          process.exit(0);
        }

        process.stdout.write(chalk.yellow(`Verifying aspects with reviewer — this may take a while. Do not interrupt.\n`));
        const coreResult = await approveNode(graph, nodePath);
        const secretsByProvider = new Map<string, Partial<LlmConfig> | null>();
        const result = await runLlmVerification(graph, nodePath, coreResult, secretsByProvider);
        formatResult(nodePath, result);
        if (result.action === 'refused') {
          process.exit(1);
        }
      } catch (error) {
        debugWrite(`[approve] command failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'running approve');
      }
    });

}
