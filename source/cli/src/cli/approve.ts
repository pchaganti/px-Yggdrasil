import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from '../formatters/cli-preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { approveNode, resolveAspects, loadSourceFiles } from '../core/approve.js';
import { runApproveWithReviewer, type LlmApproveResult } from '../core/approve-reviewer.js';
export type { LlmApproveResult };
import { collectTrackedFiles } from '../core/graph/files.js';
import { hashTrackedFiles } from '../io/hash.js';
import { classifyDrift } from '../core/check.js';
import type { CheckIssue, CascadeCause } from '../core/check.js';
import { validate } from '../core/validator.js';
import { normalizeMappingPaths } from '../io/paths.js';
import type { ApproveResult } from '../model/drift.js';
import type { Graph, LlmConfig } from '../model/graph.js';
import { readNodeDriftState } from '../io/drift-state-store.js';
import { runAstAspect } from '../ast/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { computeEffectiveAspectStatuses, getAspectStatusSources } from '../core/graph/aspects.js';
import {
  approveAspectDraftScenarioAMessage,
  approveAspectDraftScenarioBMessage,
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
  return runApproveWithReviewer({
    graph,
    nodePath,
    result,
    rootPath: graph.rootPath,
    filterAspectId,
    secretsByProvider,
    storedEntry,
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

  // Report GC'd orphaned drift state
  if (result.gcPaths && result.gcPaths.length > 0) {
    for (const p of result.gcPaths) {
      process.stdout.write(chalk.dim(`Removed orphaned drift state: ${p}\n`));
    }
  }
}

function formatLlmResults(result: LlmApproveResult): void {
  if (result.llmSkipped) {
    const messages: Record<NonNullable<LlmApproveResult['llmSkipped']>, string> = {
      'unavailable': 'Reviewer configured but not reachable — aspects not verified. Structural checks only.',
    };
    process.stdout.write(chalk.yellow(`  ${messages[result.llmSkipped]}\n`));
    return;
  }

  if (result.aspectResults) {
    const entries = Object.entries(result.aspectResults);
    const unsatisfied = entries.filter(([, r]) => !r.satisfied);
    if (unsatisfied.length === 0) {
      // All satisfied — summary already printed by formatResult
      return;
    }
    process.stdout.write('\nAspect verification:\n');
    for (const [aspectId, aspectResult] of entries) {
      if (aspectResult.satisfied) {
        process.stdout.write(chalk.green(`  ${aspectId} — SATISFIED\n`));
      } else {
        process.stdout.write(chalk.red(`  ${aspectId} — NOT SATISFIED\n`));
        process.stdout.write(`    ${aspectResult.reason}\n`);
      }
    }
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
      const result = await approveOne(nodePath);
      results[i] = {
        nodePath,
        result,
        skippedDraftAspects: result.skippedDraftAspects ?? [],
      };
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
      (c: CascadeCause) => c.file.replace(/\\/g, '/').startsWith(causePrefix),
    );
    if (hasMatchingCause) {
      matched.push(issue.nodePath);
    }
  }
  return matched;
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

// ── Gating codes — approve must not invoke LLM when these are present ──

const APPROVE_GATING_CODES = new Set([
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
  'aspect-ast-tier-not-allowed',
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
  causePrefix: string,
  filterAspectId?: string,
): Promise<boolean> {
  const issues = await classifyDrift(graph);
  const matchedNodes = filterCascadeNodes(issues, causePrefix);

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

        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath)
          .replace(/\\/g, '/').replace(/\/+$/, '');

        // --dry-run: show what would be sent to the reviewer
        if (options.dryRun && options.node) {
          const { buildPrompt } = await import('../llm/aspect-verifier.js');
          for (const rawPath of options.node) {
            const nodePath = rawPath.trim().replace(/\/$/, '');
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
              continue;
            }
            const aspects = resolveAspects(node, graph);
            const projectRoot = path.dirname(graph.rootPath);
            const trackedFiles = collectTrackedFiles(node, graph);
            const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
            const sourceFilePaths = Object.keys(fileHashes).filter(f => {
              const normalized = f.replace(/\\/g, '/').replace(/\/+$/, '');
              return !normalized.startsWith(yggPrefix);
            });
            const sourceFiles = await loadSourceFiles(sourceFilePaths, projectRoot);
            process.stdout.write(chalk.bold(`\n--- Dry run: ${nodePath} ---\n\n`));
            process.stdout.write(`Aspects (${aspects.length}): ${aspects.map(a => a.id).join(', ') || 'none'}\n`);
            process.stdout.write(`Source files (${sourceFiles.length}): ${sourceFiles.map(f => f.path).join(', ') || 'none'}\n\n`);

            const astAspects = aspects.filter(a => a.reviewer?.type === 'ast');
            const llmAspects = aspects.filter(a => a.reviewer?.type !== 'ast');

            // AST aspects — run check and print violations
            const realFilePaths = sourceFiles.map(f => f.path);
            const astParseCache = new Map();
            for (const aspect of astAspects) {
              process.stdout.write(chalk.bold(`\n--- AST aspect: ${aspect.id} ---\n\n`));
              process.stdout.write(`Files:\n`);
              for (const f of realFilePaths) {
                process.stdout.write(`  ${f}\n`);
              }
              process.stdout.write('\n');
              try {
                const astResult = await runAstAspect({
                  aspectDir: path.join('.yggdrasil/aspects', aspect.id),
                  aspectId: aspect.id,
                  files: realFilePaths.map(f => ({ path: f })),
                  projectRoot,
                  parseCache: astParseCache,
                });
                if (astResult.violations.length === 0) {
                  process.stdout.write('  no violations\n');
                } else {
                  for (const v of astResult.violations) {
                    process.stdout.write(`  ${v.file}:${v.line}: ${v.message}\n`);
                  }
                }
              } catch (e: unknown) {
                debugWrite(`[approve] dry-run ast aspect ${aspect.id}: ${e instanceof Error ? e.message : String(e)}`);
                process.stderr.write(chalk.red(buildIssueMessage({
                  what: `AST aspect '${aspect.id}' runner failed.`,
                  why: (e as Error).message,
                  next: 'Verify the aspect check.mjs is valid and that AST runner dependencies are installed.',
                }) + '\n'));
              }
            }

            // LLM aspects — show prompt for each (with references loaded for parity with real run)
            if (llmAspects.length > 0 && sourceFiles.length > 0) {
              const { loadAndIsolateReferences } = await import('../core/approve-reviewer.js');
              const { readTextFile } = await import('../io/graph-fs.js');
              const refsCache = new Map<string, string>();
              for (const aspect of llmAspects) {
                const loaded = await loadAndIsolateReferences({
                  aspectId: aspect.id,
                  references: aspect.references,
                  projectRoot,
                  cache: refsCache,
                  readTextFile,
                });
                const references = loaded.ok ? loaded.references : [];
                if (!loaded.ok) {
                  process.stdout.write(chalk.yellow(
                    `(warning: reference load failed for ${aspect.id} at dry-run time: ${loaded.reason})\n`,
                  ));
                }
                const prompt = buildPrompt(aspect, node.meta.description ?? '', nodePath, sourceFiles, references);
                process.stdout.write(chalk.bold(`\n--- Prompt for LLM aspect: ${aspect.id} ---\n`));
                process.stdout.write(prompt + '\n');
              }
            }
          }
          process.exit(0);
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
          const causePrefix = `${yggPrefix}/aspects/${aspectId}/`;
          const allPassed = await runBatchApprove(graph, `aspect '${aspectId}'`, causePrefix, aspectId);
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
          const causePrefix = `${yggPrefix}/flows/${flowName}/`;
          const allPassed = await runBatchApprove(graph, `flow '${flowName}'`, causePrefix);
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
          const allPassed = await runBatchApprove(graph, `parent node '${nodePath}'`, causePrefix);
          process.exit(allPassed ? 0 : 1);
        }

        // Has mapping — single node approve
        await abortOnGatingErrors(graph);
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
