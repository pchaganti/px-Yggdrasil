import { Command } from 'commander';
import chalk from 'chalk';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../core/graph/aspects.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  collectStructureCascade,
} from '../core/graph/impact-graph.js';
import {
  collectDescendants,
  handleAspectImpact,
  handleFlowImpact,
  handleTypeImpact,
} from './impact-handlers.js';
import { findOwner } from './owner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { readLock, LockInvalidError } from '../io/lock-store.js';
import type { LockFile } from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';

export function registerImpactCommand(program: Command): void {
  program
    .command('impact')
    .description('Show reverse dependency impact for a node, aspect, flow, or type')
    .option('--node <path>', 'Node path relative to .yggdrasil/model/')
    .option('--file <file-path>', 'Source file path — resolves owner node automatically')
    .option('--aspect <id>', 'Aspect id (directory path under aspects/)')
    .option('--flow <name>', 'Flow name (directory name under flows/)')
    .option('--type <id>', 'Architecture type id')
    .action(
      async (options: { node?: string; file?: string; aspect?: string; flow?: string; type?: string }) => {
        try {
          if (options.node && options.file) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: '--node and --file are mutually exclusive.',
                  why: 'yg impact accepts at most one of these target forms per invocation.',
                  next: 'Re-run with only --node <path> OR --file <path>.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const modeCount = [options.node || options.file, options.aspect, options.flow, options.type].filter(Boolean).length;
          if (modeCount === 0) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'No target specified.',
                  why: 'yg impact needs exactly one of --node, --file, --aspect, --flow, or --type.',
                  next: 'Pass one of: --node <path>, --file <path>, --aspect <id>, --flow <name>, --type <id>.',
                })}\n`,
              ),
            );
            process.exit(1);
          }
          if (modeCount > 1) {
            process.stderr.write(
              chalk.red(
                `Error: ${buildIssueMessage({
                  what: 'Multiple targets specified.',
                  why: 'yg impact accepts only one of --node/--file, --aspect, --flow, or --type per invocation.',
                  next: 'Re-run with a single target form.',
                })}\n`,
              ),
            );
            process.exit(1);
          }

          const graph = await loadGraphOrAbort(process.cwd());
          initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

          // Load the lock ONCE per command. A garbled/unknown-version lock fails
          // closed with a clear error — impact cannot reason about cross-node
          // file invalidation or refused verdicts without a readable lock.
          let lock: LockFile;
          try {
            lock = readLock(graph.rootPath);
          } catch (err) {
            if (err instanceof LockInvalidError) {
              debugWrite(`[impact] readLock failed: ${err.message}`);
              process.stderr.write(chalk.red(`Error: ${buildIssueMessage(err.messageData)}\n`));
              await exitAfterFlush(1);
            }
            throw err;
          }

          // Resolve --file to --node (structural owner) + cascade-via-reference scan
          if (options.file) {
            const repoRoot = projectRootFromGraph(graph.rootPath);
            const repoRelative = resolveFileArg(repoRoot, options.file);
            const ownerResult = findOwner(graph, repoRoot, repoRelative);

            // Scan all nodes to find those whose aspect references include this file.
            // An aspect reference is hashed into every LLM pair of nodes carrying
            // that aspect, so editing the file invalidates those pairs.
            const refCascadeNodes: string[] = [];
            for (const [nodePath, node] of graph.nodes) {
              // Skip the structural owner — it's handled separately
              if (ownerResult.nodePath && nodePath === ownerResult.nodePath) continue;
              const effective = computeEffectiveAspects(node, graph);
              const hasRef = [...effective].some(aspectId => {
                const aspect = graph.aspects.find(a => a.id === aspectId);
                return aspect?.references?.some(r => r.path === repoRelative);
              });
              if (hasRef) refCascadeNodes.push(nodePath);
            }
            refCascadeNodes.sort();

            // Structure-aspect cascade: nodes whose effective deterministic aspect
            // OBSERVES this file CROSS-NODE (precise, from the lock's `touched`
            // maps; cold-start fallback = potential). See collectStructureCascade.
            const structureCascade = collectStructureCascade(graph, repoRelative, ownerResult.nodePath, lock);

            if (!ownerResult.nodePath && refCascadeNodes.length === 0 && structureCascade.length === 0) {
              process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
                what: `${repoRelative} -> no graph coverage`,
                why: 'file is not mapped to any node, is not referenced by any aspect, and is not observed by any deterministic aspect in the graph.',
                next: 'Add the file to an existing node mapping, or create a new node.',
              })}\n`));
              process.exit(1);
            }

            // Show cascade-via-reference section if any
            if (refCascadeNodes.length > 0) {
              process.stdout.write(`\nNodes whose aspects reference ${repoRelative} [reference]:\n`);
              for (const np of refCascadeNodes) {
                process.stdout.write(`  ${np} [reference]\n`);
              }
              process.stdout.write(
                `\nBlast radius via references: ${refCascadeNodes.length} node(s) — ` +
                `editing this file would make their LLM pairs unverified (re-verified by yg check --approve).\n`,
              );
            }

            // Show structure-cascade section if any
            if (structureCascade.length > 0) {
              process.stdout.write(`\nNodes whose deterministic aspects observe ${repoRelative} [structure]:\n`);
              for (const { nodePath, mode } of structureCascade) {
                const suffix = mode === 'potential' ? ' [structure, potential]' : ' [structure]';
                process.stdout.write(`  ${toPosixPath(nodePath)}${suffix}\n`);
              }
              process.stdout.write(
                `\nBlast radius via deterministic aspects: ${structureCascade.length} node(s) — ` +
                `editing this file would make their deterministic pairs unverified ` +
                `(re-verified for free by yg check --approve).\n`,
              );
            }

            if (!ownerResult.nodePath) {
              // Only cascade nodes found — no structural owner to follow. The
              // cascade/blast-radius sections above can be long; drain stdout
              // before the force-exit so a piped consumer is not truncated.
              process.stdout.write(
                `\nNext: review the cascade nodes above, then edit; run yg context --node <X> for any you're unsure about.\n`,
              );
              await exitAfterFlush(0);
              return; // unreachable — keeps TS narrowing ownerResult.nodePath to string
            }

            // Structural owner found — continue to regular node impact
            process.stdout.write(`${ownerResult.file} -> ${ownerResult.nodePath}\n`);
            options.node = ownerResult.nodePath;
          }

          if (options.aspect) {
            await handleAspectImpact(graph, options.aspect.trim(), lock);
            return;
          }
          if (options.flow) {
            await handleFlowImpact(graph, options.flow.trim());
            return;
          }
          if (options.type) {
            await handleTypeImpact(graph, options.type.trim());
            return;
          }

          const nodePath = options.node!.trim().replace(/\/$/, '');

          if (!graph.nodes.has(nodePath)) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Node not found: ${nodePath}`,
              why: 'The node path must match a node in the graph.',
              next: 'Run: yg tree — to list all nodes.',
            })}\n`));
            process.exit(1);
          }

          const { direct, allDependents, reverse, relationFrom } = collectReverseDependents(
            graph,
            nodePath,
          );

          const chains = buildTransitiveChains(nodePath, direct, allDependents, reverse);

          // Collect event-based dependents (emits/listens)
          const eventDependents: Array<{ path: string; type: string; eventName: string }> = [];
          for (const [np, n] of graph.nodes) {
            for (const rel of n.meta.relations ?? []) {
              if (rel.target === nodePath && (rel.type === 'emits' || rel.type === 'listens')) {
                eventDependents.push({
                  path: np,
                  type: rel.type,
                  eventName: rel.event_name ?? n.meta.name,
                });
              }
            }
          }
          // Also check if the target node emits events and find listeners
          const targetNode = graph.nodes.get(nodePath)!;
          for (const rel of targetNode.meta.relations ?? []) {
            if (rel.type === 'emits') {
              const eventName = rel.event_name ?? rel.target;
              // Find listeners for this event target
              for (const [np, n] of graph.nodes) {
                if (np === nodePath) continue;
                for (const r of n.meta.relations ?? []) {
                  if (r.type === 'listens' && r.target === rel.target) {
                    eventDependents.push({
                      path: np,
                      type: 'listens',
                      eventName: r.event_name ?? eventName,
                    });
                  }
                }
              }
            }
          }

          const flows: string[] = [];
          for (const flow of graph.flows) {
            if (flow.nodes.includes(nodePath)) {
              flows.push(flow.name);
            }
          }

          const targetNodeForAspects = graph.nodes.get(nodePath)!;
          const targetEffective = computeEffectiveAspects(targetNodeForAspects, graph);
          const targetStatuses = computeEffectiveAspectStatuses(targetNodeForAspects, graph);
          const aspectsInScope: string[] = [];
          for (const aspect of graph.aspects) {
            if (targetEffective.has(aspect.id)) {
              const status = targetStatuses.get(aspect.id) ?? aspect.status ?? 'enforced';
              aspectsInScope.push(`${aspect.name} [${status}]`);
            }
          }

          process.stdout.write(`Impact of changes in ${nodePath}:\n\n`);
          process.stdout.write('Directly dependent:\n');
          if (direct.length === 0) {
            process.stdout.write('  (none)\n');
          } else {
            for (const dep of direct) {
              const rel = relationFrom.get(`${dep}->${nodePath}`);
              const annot = rel?.consumes?.length
                ? ` (${rel.type}, consumes: ${rel.consumes.join(', ')})`
                : rel
                  ? ` (${rel.type})`
                  : '';
              process.stdout.write(`  <- ${dep}${annot}\n`);
            }
          }

          if (eventDependents.length > 0) {
            process.stdout.write('\nEvent-connected:\n');
            for (const { path: p, type, eventName } of eventDependents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
              process.stdout.write(`  ${p} (${type}: ${eventName})\n`);
            }
          }
          process.stdout.write('\nTransitively dependent:\n');
          if (chains.length === 0) {
            process.stdout.write('  (none)\n');
          } else {
            for (const chain of chains) {
              process.stdout.write(`  ${chain}\n`);
            }
          }

          const descendants = collectDescendants(graph, nodePath);
          if (descendants.length > 0) {
            process.stdout.write('\nDescendants (hierarchy impact):\n');
            for (const desc of descendants) {
              process.stdout.write(`  ${desc}\n`);
            }
          }

          // Collect indirect dependents of descendants
          const alreadyShown = new Set([nodePath, ...allDependents, ...descendants, ...eventDependents.map((e) => e.path)]);
          let descIndirectPaths: string[] = [];
          if (descendants.length > 0) {
            const { indirectPaths: rawIndirect, chains: rawChains } = collectIndirectDependents(graph, descendants);
            const filteredIndirect: string[] = [];
            const filteredChains: string[] = [];
            for (let i = 0; i < rawIndirect.length; i++) {
              if (!alreadyShown.has(rawIndirect[i])) {
                filteredIndirect.push(rawIndirect[i]);
                filteredChains.push(rawChains[i]);
              }
            }
            descIndirectPaths = filteredIndirect;
            if (filteredChains.length > 0) {
              process.stdout.write('\nIndirectly affected (structural dependents of descendants):\n');
              for (const chain of filteredChains) {
                process.stdout.write(`  ${chain}\n`);
              }
            }
          }

          process.stdout.write(
            `\nFlows: ${flows.length > 0 ? flows.join(', ') : '(none)'}\n`,
          );
          process.stdout.write(
            `Aspects: ${aspectsInScope.length > 0 ? aspectsInScope.join(', ') : '(none)'}\n`,
          );

          // A "ubiquitous" aspect (effective on many nodes — a posix/style check
          // attached to most of the graph) is a co-occurrence, not a real
          // dependency: every node "shares" it, so it adds no signal and only
          // buries the actionable blast-radius footer. Count effective nodes per
          // target aspect once, then omit any aspect over the threshold from the
          // "Nodes sharing aspects" section (with a one-line note).
          const UBIQUITOUS_THRESHOLD = 20;
          const aspectEffectiveCount = new Map<string, number>();
          for (const [p] of graph.nodes) {
            const eff = computeEffectiveAspects(graph.nodes.get(p)!, graph);
            for (const id of targetEffective) {
              if (eff.has(id)) aspectEffectiveCount.set(id, (aspectEffectiveCount.get(id) ?? 0) + 1);
            }
          }
          const ubiquitousAspects = [...targetEffective].filter(
            (id) => (aspectEffectiveCount.get(id) ?? 0) > UBIQUITOUS_THRESHOLD,
          );
          const ubiquitousSet = new Set(ubiquitousAspects);

          const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
          if (targetEffective.size > 0) {
            for (const [p] of graph.nodes) {
              if (p === nodePath) continue;
              const otherNode = graph.nodes.get(p)!;
              const nodeEffective = computeEffectiveAspects(otherNode, graph);
              const otherStatuses = computeEffectiveAspectStatuses(otherNode, graph);
              const shared = [...targetEffective]
                .filter((id) => nodeEffective.has(id) && !ubiquitousSet.has(id))
                .map((id) => {
                  const aspectDef = graph.aspects.find(a => a.id === id);
                  const status = otherStatuses.get(id) ?? aspectDef?.status ?? 'enforced';
                  return `${id} [${status}]`;
                });
              if (shared.length > 0) {
                coAspectNodes.push({ path: p, shared });
              }
            }
          }
          if (coAspectNodes.length > 0) {
            process.stdout.write('Nodes sharing aspects:\n');
            for (const { path: p, shared } of coAspectNodes.sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            )) {
              process.stdout.write(`  ${p} (${shared.join(', ')})\n`);
            }
          }
          if (ubiquitousAspects.length > 0) {
            process.stdout.write(
              `  (${ubiquitousAspects.length} ubiquitous aspect${ubiquitousAspects.length === 1 ? '' : 's'} omitted — they don't indicate a real dependency)\n`,
            );
          }

          const allAffected = new Set([...allDependents, ...descendants, ...eventDependents.map((e) => e.path), ...descIndirectPaths]);
          process.stdout.write(
            `\nBlast radius: ${allAffected.size} nodes, ${flows.length} flows, ${aspectsInScope.length} aspects\n`,
          );
          process.stdout.write(
            `  Editing this node re-verifies its own pairs on the next yg check --approve; ` +
            `the ${allAffected.size} dependent node(s) above are where a behavioural change may need review.\n`,
          );
          if (allAffected.size >= 10) {
            process.stdout.write(`  High blast radius — review direct dependents before changing this node.\n`);
          } else if (allAffected.size > 0) {
            process.stdout.write(`  Review direct dependents before changing this node.\n`);
          }
          process.stdout.write(
            `\nNext: review the dependents above, then edit; run yg context --node ${toPosixPath(nodePath)} for any you're unsure about.\n`,
          );
        } catch (error) {
          debugWrite(`[impact] command failed: ${(error as Error).message}`);
          abortOnUnexpectedError(error, 'running impact');
        }
      },
    );
}
