import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraph } from '../core/graph-loader.js';
import { initDebugLog } from '../utils/debug-log.js';
import { approveNode, resolveAspects, loadSourceFiles, commitApproval } from '../core/approve.js';
import { runApproveWithReviewer, type LlmApproveResult } from '../core/approve-reviewer.js';
export type { LlmApproveResult };
import { collectTrackedFiles } from '../core/context-files.js';
import { hashTrackedFiles } from '../utils/hash.js';
import { classifyDrift } from '../core/check.js';
import type { CheckIssue, CascadeCause } from '../core/check.js';
import { createLlmProvider } from '../llm/index.js';
import { loadSecrets, mergeLlmConfig } from '../io/secrets-parser.js';
import { normalizeMappingPaths } from '../utils/paths.js';
import type { LlmProvider } from '../llm/types.js';
import type { ApproveResult, AspectVerificationResult } from '../model/drift.js';
import type { Graph } from '../model/graph.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';

/** LLM configuration resolved from graph config */
export interface LlmConfig {
  provider: LlmProvider | undefined;
  maxTokens: number | undefined;
  consensus: number | undefined;
}

/**
 * Run aspect verification on an approved node result, returning an extended result.
 * Handles AST aspects in CLI layer; delegates LLM aspects to core/approve-reviewer.
 * If any aspect refuses, the result action is set to 'refused'.
 */
export async function runLlmVerification(
  graph: Graph,
  nodePath: string,
  result: ApproveResult,
  llmConfig: LlmConfig,
): Promise<LlmApproveResult> {
  const { provider } = llmConfig;
  const node = graph.nodes.get(nodePath);

  if (!provider) {
    await commitApproval(graph.rootPath, result);
    return { ...result, llmSkipped: 'unavailable' };
  }

  if (result.action === 'refused' || !node) {
    return result;
  }

  const aspects = resolveAspects(node, graph);
  const astAspects = aspects.filter(a => a.reviewer === 'ast');

  if (astAspects.length === 0) {
    return runApproveWithReviewer({ graph, nodePath, result, provider, maxTokens: llmConfig.maxTokens, consensus: llmConfig.consensus });
  }

  // Compute source file paths for AST verification
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = path.relative(projectRoot, graph.rootPath).split(path.sep).join('/');
  const trackedFiles = collectTrackedFiles(node, graph);
  const { fileHashes } = await hashTrackedFiles(projectRoot, trackedFiles, undefined, []);
  const sourceFilePaths = Object.keys(fileHashes).filter(f => {
    const normalized = f.replace(/\\/g, '/').replace(/\/+$/, '');
    return !normalized.startsWith(yggPrefix);
  });

  // Run AST aspects
  const astResults: Record<string, AspectVerificationResult> = {};
  for (const aspect of astAspects) {
    try {
      const astResult = await runAstAspect({
        aspectDir: path.join('.yggdrasil/aspects', aspect.id),
        aspectId: aspect.id,
        files: sourceFilePaths.map(f => ({ path: f })),
        projectRoot,
      });
      const violated = astResult.violations.length > 0;
      astResults[aspect.id] = {
        satisfied: !violated,
        reason: violated
          ? astResult.violations.map(v => `${v.file}:${v.line}: ${v.message}`).join('\n')
          : 'all rules satisfied',
      };
    } catch (e: unknown) {
      const code: string = (e as { code?: string }).code ?? 'AST_RUNNER_UNKNOWN';
      const rendered = e instanceof AstRunnerError
        ? buildIssueMessage(e.messageData)
        : (e as Error).message;
      astResults[aspect.id] = { satisfied: false, reason: `[${code}] ${rendered}` };
    }
  }

  const astViolations = Object.entries(astResults)
    .filter(([, r]) => !r.satisfied)
    .map(([aspectId, r]) => ({ aspectId, reason: r.reason }));

  if (astViolations.length > 0) {
    return {
      ...result,
      action: 'refused',
      refuseReasonData: {
        what: 'Reviewer found aspect violations.',
        why: 'One or more aspects were not satisfied by the source code.',
        next: `Fix the violations and re-run: yg approve --node ${nodePath}`,
      },
      aspectResults: astResults,
      aspectViolations: astViolations,
    };
  }

  // AST passed — delegate LLM verification to core
  const llmResult = await runApproveWithReviewer({ graph, nodePath, result, provider, maxTokens: llmConfig.maxTokens, consensus: llmConfig.consensus });
  return {
    ...llmResult,
    aspectResults: { ...astResults, ...(llmResult.aspectResults ?? {}) },
  };
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
    process.stdout.write(chalk.dim(`  ${messages[result.llmSkipped]}\n`));
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
    process.stderr.write(
      chalk.red(`ERROR: Reviewer found aspect violations.\n`),
    );
    process.stderr.write(
      `  Fix the violations and re-run: yg approve --node ${nodePath}\n`,
    );
    return;
  }

  // Fallback
  process.stderr.write(
    chalk.red(`ERROR: ${result.refuseReasonData ? buildIssueMessage(result.refuseReasonData) : 'Approve refused.'}\n`),
  );
}

// ── Batch types and execution ─────────────────────────────────

export interface BatchResult {
  nodePath: string;
  result: LlmApproveResult;
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
      results[i] = { nodePath, result: await approveOne(nodePath) };
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

export function formatBatchOutput(results: BatchResult[]): void {
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

  process.stdout.write(`\n${approved} approved, ${failed} failed.\n`);
}

// ── Reviewer provider loading ────────────────────────────────

async function loadLlmProvider(
  graph: { rootPath: string; config: { llm?: import('../model/graph.js').LlmConfig } },
): Promise<{ provider: LlmProvider | undefined; maxTokens: number | undefined; consensus: number | undefined }> {
  const llmConfig = graph.config.llm;
  if (!llmConfig) {
    throw new Error('No reviewer configured. Add a reviewer section to yg-config.yaml or run yg init to set one up.');
  }

  const secrets = await loadSecrets(graph.rootPath, llmConfig.provider);
  const mergedConfig = secrets ? mergeLlmConfig(llmConfig, secrets) : llmConfig;
  const provider = createLlmProvider(mergedConfig);

  if (!(await provider.isAvailable())) {
    return { provider: undefined, maxTokens: undefined, consensus: undefined };
  }

  const maxTokens = mergedConfig.max_tokens === 'auto'
    ? (await provider.getContextWindowSize() ?? 8192)
    : (mergedConfig.max_tokens as number);

  return { provider, maxTokens, consensus: mergedConfig.consensus };
}

// ── Batch approve orchestrator ───────────────────────────────

async function runBatchApprove(
  graph: Graph,
  entityLabel: string,
  causePrefix: string,
): Promise<boolean> {
  const issues = await classifyDrift(graph);
  const matchedNodes = filterCascadeNodes(issues, causePrefix);

  if (matchedNodes.length === 0) {
    process.stdout.write(`No cascade drift found for ${entityLabel}.\n`);
    return true;
  }

  const { provider, maxTokens, consensus } = await loadLlmProvider(graph);

  const parallel = graph.config.parallel ?? 1;
  const sorted = matchedNodes.sort();

  if (parallel > 1) {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel} (parallel: ${parallel})...\n\n`);
  } else {
    process.stdout.write(`Approving ${sorted.length} nodes cascaded from ${entityLabel}...\n`);
  }

  const llmCfg: LlmConfig = { provider, maxTokens, consensus };
  const results = await runBatch(sorted, parallel, async (nodePath) => {
    const result = await approveNode(graph, nodePath);
    return runLlmVerification(graph, nodePath, result, llmCfg);
  });

  formatBatchOutput(results);
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
          process.stderr.write(chalk.red('ERROR: One of --node, --aspect, or --flow is required.\n'));
          process.exit(1);
        }
        if (targets.length > 1) {
          process.stderr.write(chalk.red('ERROR: Only one of --node, --aspect, or --flow can be specified.\n'));
          process.exit(1);
        }

        const graph = await loadGraph(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false);
        const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath)
          .replace(/\\/g, '/').replace(/\/+$/, '');

        // --dry-run: show what would be sent to the reviewer
        if (options.dryRun && options.node) {
          const { buildPrompt } = await import('../llm/aspect-verifier.js');
          for (const rawPath of options.node) {
            const nodePath = rawPath.trim().replace(/\/$/, '');
            const node = graph.nodes.get(nodePath);
            if (!node) { process.stderr.write(chalk.red(`Node '${nodePath}' not found.\n`)); continue; }
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

            const astAspects = aspects.filter(a => a.reviewer === 'ast');
            const llmAspects = aspects.filter(a => a.reviewer !== 'ast');

            // AST aspects — run check and print violations
            for (const aspect of astAspects) {
              process.stdout.write(chalk.bold(`\n--- AST aspect: ${aspect.id} ---\n\n`));
              process.stdout.write(`Files:\n`);
              for (const f of sourceFilePaths) {
                process.stdout.write(`  ${f}\n`);
              }
              process.stdout.write('\n');
              try {
                const astResult = await runAstAspect({
                  aspectDir: path.join('.yggdrasil/aspects', aspect.id),
                  aspectId: aspect.id,
                  files: sourceFilePaths.map(f => ({ path: f })),
                  projectRoot,
                });
                if (astResult.violations.length === 0) {
                  process.stdout.write('  no violations\n');
                } else {
                  for (const v of astResult.violations) {
                    process.stdout.write(`  ${v.file}:${v.line}: ${v.message}\n`);
                  }
                }
              } catch (e: unknown) {
                process.stdout.write(chalk.red(`  Error: ${(e as Error).message}\n`));
              }
            }

            // LLM aspects — show prompt for first
            if (llmAspects.length > 0 && sourceFiles.length > 0) {
              const prompt = buildPrompt(llmAspects[0], node.meta.description ?? '', nodePath, sourceFiles);
              process.stdout.write(chalk.dim('--- Prompt for first LLM aspect ---\n'));
              process.stdout.write(prompt + '\n');
            }
          }
          process.exit(0);
        }

        // --aspect: batch approve all nodes with cascade drift from this aspect
        if (options.aspect) {
          const aspectId = options.aspect.trim();
          const aspectExists = graph.aspects.some(a => a.id === aspectId);
          if (!aspectExists) {
            process.stderr.write(chalk.red(`ERROR: Aspect '${aspectId}' does not exist.\n`));
            process.exit(1);
          }
          const causePrefix = `${yggPrefix}/aspects/${aspectId}/`;
          const allPassed = await runBatchApprove(graph, `aspect '${aspectId}'`, causePrefix);
          process.exit(allPassed ? 0 : 1);
        }

        // --flow: batch approve all nodes with cascade drift from this flow
        if (options.flow) {
          const flowName = options.flow.trim();
          const flowExists = graph.flows.some(f => f.path === flowName);
          if (!flowExists) {
            process.stderr.write(chalk.red(`ERROR: Flow '${flowName}' does not exist.\n`));
            process.exit(1);
          }
          const causePrefix = `${yggPrefix}/flows/${flowName}/`;
          const allPassed = await runBatchApprove(graph, `flow '${flowName}'`, causePrefix);
          process.exit(allPassed ? 0 : 1);
        }

        // --node: multi-node batch or single node
        if (options.node && options.node.length > 1) {
          const parallel = graph.config.parallel ?? 1;
          const nodePaths = options.node.map(n => n.trim().replace(/\/$/, ''));
          const { provider, maxTokens, consensus } = await loadLlmProvider(graph);
          if (parallel > 1) {
            process.stdout.write(`Approving ${nodePaths.length} nodes (parallel: ${parallel})...\n\n`);
          } else {
            process.stdout.write(`Approving ${nodePaths.length} nodes...\n`);
          }
          const llmCfg: LlmConfig = { provider, maxTokens, consensus };
          const batchResults = await runBatch(nodePaths, parallel, async (nodePath) => {
            const result = await approveNode(graph, nodePath);
            return runLlmVerification(graph, nodePath, result, llmCfg);
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
          process.stderr.write(chalk.red(`ERROR: Node '${nodePath}' does not exist.\n`));
          process.exit(1);
        }

        const mappingPaths = normalizeMappingPaths(node.meta.mapping);
        if (mappingPaths.length === 0) {
          const causePrefix = `${yggPrefix}/model/${nodePath}/`;
          const allPassed = await runBatchApprove(graph, `parent node '${nodePath}'`, causePrefix);
          process.exit(allPassed ? 0 : 1);
        }

        // Has mapping — single node approve
        const { provider, maxTokens, consensus } = await loadLlmProvider(graph);
        if (provider) {
          process.stdout.write(chalk.dim(`Verifying aspects with reviewer — this may take a while. Do not interrupt.\n`));
        }
        const coreResult = await approveNode(graph, nodePath);
        const llmCfg: LlmConfig = { provider, maxTokens, consensus };
        const result = await runLlmVerification(graph, nodePath, coreResult, llmCfg);
        formatResult(nodePath, result);
        if (result.action === 'refused') {
          process.exit(1);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          process.stderr.write(
            chalk.red(`Error: No .yggdrasil/ directory found. Run 'yg init' first.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
        }
        process.exit(1);
      }
    });

}
