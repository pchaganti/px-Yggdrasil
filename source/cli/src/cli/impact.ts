import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { collectAncestors } from '../core/context-builder.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../core/graph/aspects.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  collectStructureCascade,
  nodesWithRefusedVerdict,
} from '../core/graph/impact-graph.js';
import { findOwner } from './owner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { evaluateFileWhen } from '../core/file-when-evaluator.js';
import { readLock, LockInvalidError } from '../io/lock-store.js';
import { computeExpectedPairs } from '../core/pairs.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';

export function collectDescendants(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) return [];
  const result: string[] = [];
  const stack = [...node.children];
  while (stack.length > 0) {
    const child = stack.pop()!;
    result.push(child.path);
    stack.push(...child.children);
  }
  return result.sort();
}

async function handleAspectImpact(
  graph: Graph,
  aspectId: string,
  lock: LockFile,
): Promise<void> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Aspect not found: ${aspectId}`,
      why: 'The aspect id must match a directory name under .yggdrasil/aspects/.',
      next: 'Run: yg aspects — to list all defined aspects.',
    })}\n`));
    process.exit(1);
  }

  // Nodes currently holding a refused verdict for this aspect (lock scan, no IO).
  const refusedNodes = nodesWithRefusedVerdict(graph, lock, aspectId);

  const affected: Array<{ path: string; source: string; status: string; refused: boolean }> = [];
  for (const [nodePath, node] of graph.nodes) {
    const effective = computeEffectiveAspects(node, graph);
    if (effective.has(aspectId)) {
      const statuses = computeEffectiveAspectStatuses(node, graph);
      const status = statuses.get(aspectId) ?? aspect.status ?? 'enforced';
      const refused = refusedNodes.has(nodePath);
      const ownAspectIds = new Set(node.meta.aspects ?? []);
      if (ownAspectIds.has(aspectId)) {
        affected.push({ path: nodePath, source: 'own', status, refused });
      } else {
        let fromHierarchy = false;
        let anc = node.parent;
        while (anc) {
          if ((anc.meta.aspects ?? []).includes(aspectId)) {
            fromHierarchy = true;
            break;
          }
          anc = anc.parent;
        }
        if (fromHierarchy) {
          affected.push({ path: nodePath, source: `hierarchy from ${anc!.path}`, status, refused });
        } else {
          const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
          const flow = graph.flows.find(
            (f) =>
              (f.aspects ?? []).includes(aspectId) &&
              f.nodes.some((n) => ancestorPaths.has(n)),
          );
          affected.push({ path: nodePath, source: flow ? `flow: ${flow.name}` : 'implied', status, refused });
        }
      }
    }
  }

  affected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { indirectPaths, chains } = collectIndirectDependents(
    graph,
    affected.map((a) => a.path),
  );

  const propagatingFlows = graph.flows
    .filter((f) => (f.aspects ?? []).includes(aspectId))
    .map((f) => f.name);

  const impliedBy = graph.aspects
    .filter((a) => (a.implies ?? []).includes(aspectId))
    .map((a) => a.id);
  const implies = aspect.implies ?? [];

  // Cost: how many pairs of THIS aspect would become unverified, and (for an LLM
  // aspect) the reviewer calls a re-fill would cost. per: file scope produces one
  // unit per subject file, so count from the expected-pair set, not node count.
  const cost = await computeAspectFillCost(graph, aspectId);

  process.stdout.write(`Impact of changes in aspect ${aspectId}:\n\n`);
  process.stdout.write(`Directly affected (${affected.length}):\n`);
  if (affected.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const { path: p, source, status, refused } of affected) {
      const refusedTag = refused ? ' [refused]' : '';
      process.stdout.write(`  ${p} (${source}) [${status}]${refusedTag}\n`);
    }
  }
  if (chains.length > 0) {
    process.stdout.write(`\nIndirectly affected (structural dependents):\n`);
    for (const chain of chains) {
      process.stdout.write(`  ${chain}\n`);
    }
  }
  process.stdout.write(
    `\nFlows propagating this aspect: ${propagatingFlows.length > 0 ? propagatingFlows.join(', ') : '(none)'}\n`,
  );
  process.stdout.write(`Implied by: ${impliedBy.length > 0 ? impliedBy.join(', ') : '(none)'}\n`);
  process.stdout.write(`Implies: ${implies.length > 0 ? implies.join(', ') : '(none)'}\n`);
  process.stdout.write(`\nBlast radius: ${affected.length + indirectPaths.length} nodes, ${propagatingFlows.length} flows\n`);
  process.stdout.write(renderFillCost(cost, affected.length));
  const totalAffected = affected.length + indirectPaths.length;
  if (totalAffected >= 10) {
    process.stdout.write(`  High blast radius — review aspect requirements in affected nodes before modifying this aspect.\n`);
  }

}

interface FillCost {
  kind: 'llm' | 'deterministic' | 'unknown';
  units: number;        // expected pairs of the aspect (per: file → one per file)
  reviewerCalls: number; // units × resolved consensus (0 for deterministic)
}

/**
 * Cost of re-filling every pair of `aspectId` after a change to it: the unit
 * count (one per expected pair) and, for an LLM aspect, the reviewer calls a
 * re-fill would dispatch (units × the resolved tier consensus). Deterministic
 * aspects are free (0 reviewer calls).
 */
async function computeAspectFillCost(graph: Graph, aspectId: string): Promise<FillCost> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  const { pairs } = await computeExpectedPairs(graph);
  const units = pairs.filter((p) => p.aspectId === aspectId).length;

  if (!aspect || aspect.reviewer.type === 'deterministic') {
    return { kind: 'deterministic', units, reviewerCalls: 0 };
  }
  if (aspect.reviewer.type !== 'llm') {
    return { kind: 'unknown', units, reviewerCalls: 0 };
  }

  const reviewer = graph.config.reviewer;
  const tier = reviewer ? selectTierForAspect(aspect, reviewer) : undefined;
  const consensus = tier?.ok ? tier.tier.consensus : 1;
  return { kind: 'llm', units, reviewerCalls: units * consensus };
}

/** Render the cost lines for an aspect change in lock vocabulary (no drift words). */
function renderFillCost(cost: FillCost, affectedNodes: number): string {
  if (cost.units === 0) {
    return `  No verified pairs of this aspect exist yet — a change re-verifies them on the next yg check --approve.\n`;
  }
  if (cost.kind === 'deterministic') {
    return (
      `  All ${affectedNodes} affected node(s) (${cost.units} pair(s)) would become unverified if this aspect changes — ` +
      `re-verified for free by yg check --approve (deterministic, no reviewer calls).\n`
    );
  }
  return (
    `  All ${affectedNodes} affected node(s) (${cost.units} pair(s)) would become unverified if this aspect changes — ` +
    `re-verified by yg check --approve at ${cost.reviewerCalls} reviewer call(s) (consensus included).\n`
  );
}

async function handleFlowImpact(
  graph: Graph,
  flowName: string,
): Promise<void> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Flow not found: ${flowName}`,
      why: 'The flow name must match a directory name under .yggdrasil/flows/.',
      next: 'Run: yg flows — to list all defined flows.',
    })}\n`));
    process.exit(1);
  }

  const participants = new Set<string>();
  for (const nodePath of flow.nodes) {
    if (graph.nodes.has(nodePath)) {
      participants.add(nodePath);
      for (const desc of collectDescendants(graph, nodePath)) {
        participants.add(desc);
      }
    }
  }

  const sorted = [...participants].sort();
  const flowAspects = flow.aspects ?? [];

  const { indirectPaths, chains } = collectIndirectDependents(graph, sorted);

  process.stdout.write(`Impact of changes in flow ${flow.name}:\n\n`);
  process.stdout.write('Participants:\n');
  if (sorted.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const p of sorted) {
      const isDeclared = flow.nodes.includes(p);
      const suffix = isDeclared ? '' : ' (descendant)';
      process.stdout.write(`  ${p}${suffix}\n`);
    }
  }
  if (chains.length > 0) {
    process.stdout.write(`\nIndirectly affected (structural dependents):\n`);
    for (const chain of chains) {
      process.stdout.write(`  ${chain}\n`);
    }
  }
  process.stdout.write(
    `\nFlow aspects: ${flowAspects.length > 0 ? flowAspects.join(', ') : '(none)'}\n`,
  );
  const declaredParticipants = flow.nodes.filter((n) => graph.nodes.has(n));
  process.stdout.write(`\nBlast radius: ${sorted.length + indirectPaths.length} nodes\n`);
  process.stdout.write(`  All ${declaredParticipants.length} participant(s) would become unverified if this flow's aspect or participant set changes — re-verified by yg check --approve.\n`);
  const totalFlowAffected = sorted.length + indirectPaths.length;
  if (totalFlowAffected >= 10) {
    process.stdout.write(`  High blast radius — review flow compliance in participants before modifying.\n`);
  }

}

async function handleTypeImpact(graph: Graph, typeId: string): Promise<void> {
  const def = graph.architecture.node_types[typeId];
  if (!def) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
      what: `Type '${typeId}' not found in architecture.`,
      why: 'The type id must match a node_types key in .yggdrasil/yg-architecture.yaml.',
      next: 'Read .yggdrasil/yg-architecture.yaml to see defined types.',
    })}\n`));
    process.exit(1);
  }

  const projectRoot = join(graph.rootPath, '..');

  process.stdout.write(`\nType: ${typeId}\n`);
  process.stdout.write(`Description: ${def.description}\n`);
  if (def.enforce === 'strict') process.stdout.write(`enforce: strict\n`);
  if (def.when) {
    const { stringify } = await import('yaml');
    const rendered = stringify(def.when, { lineWidth: 0 }).trimEnd();
    process.stdout.write(`when:\n`);
    for (const line of rendered.split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
  }
  if (def.aspects && def.aspects.length > 0) {
    process.stdout.write(`aspects: [${def.aspects.join(', ')}]\n`);
  }

  const nodesOfType: string[] = [];
  for (const [nodePath, node] of graph.nodes) {
    if (node.meta.type === typeId) nodesOfType.push(nodePath);
  }
  nodesOfType.sort();

  process.stdout.write(`\nNodes of this type (${nodesOfType.length}):\n`);
  for (const p of nodesOfType) {
    process.stdout.write(`  ${p}\n`);
  }

  const sourceFiles: Array<{ path: string; node: string }> = [];
  for (const nodePath of nodesOfType) {
    for (const p of graph.nodes.get(nodePath)?.meta.mapping ?? []) {
      sourceFiles.push({ path: p, node: nodePath });
    }
  }
  process.stdout.write(`\nSource files covered (${sourceFiles.length}):\n`);
  for (const f of sourceFiles.slice(0, 20)) {
    process.stdout.write(`  ${f.path} (in ${f.node})\n`);
  }
  if (sourceFiles.length > 20) {
    process.stdout.write(`  ... (${sourceFiles.length - 20} more)\n`);
  }

  if (def.enforce === 'strict' && def.when) {
    const cache = new FileContentCache();
    const repoFiles = await walkRepoFiles(projectRoot);
    const owners = new Map<string, string>();
    for (const [np, n] of graph.nodes) {
      for (const m of n.meta.mapping ?? []) owners.set(m, np);
    }
    const orphans: string[] = [];
    const misplaced: Array<{ file: string; owner: string; ownerType: string }> = [];
    for (const rel of repoFiles) {
      const abs = join(projectRoot, rel);
      const result = await evaluateFileWhen(def.when, {
        absPath: abs, repoRelPath: rel, projectRoot, cache,
      });
      if (!result.result) continue;
      const owner = owners.get(rel);
      if (owner === undefined) {
        orphans.push(rel);
      } else {
        const ownerType = graph.nodes.get(owner)?.meta.type ?? '?';
        if (ownerType !== typeId) misplaced.push({ file: rel, owner, ownerType });
      }
    }
    if (orphans.length === 0 && misplaced.length === 0) {
      process.stdout.write(
        `\nStrict coverage gap (0 files): None — all files satisfying when are in ${typeId}-type nodes.\n`,
      );
    } else {
      process.stdout.write(`\nStrict coverage gap:\n`);
      process.stdout.write(`  Orphans (matching files not in any mapping): ${orphans.length}\n`);
      for (const p of orphans.slice(0, 10)) process.stdout.write(`    ${p}\n`);
      if (orphans.length > 10) process.stdout.write(`    ... (${orphans.length - 10} more)\n`);
      process.stdout.write(`  Misplaced (in wrong-type node mapping): ${misplaced.length}\n`);
      for (const m of misplaced.slice(0, 10)) {
        process.stdout.write(`    ${m.file} → ${m.owner} (type: ${m.ownerType})\n`);
      }
      if (misplaced.length > 10) process.stdout.write(`    ... (${misplaced.length - 10} more)\n`);
    }
  }
  process.stdout.write('\n');
}

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

          const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
          if (targetEffective.size > 0) {
            for (const [p] of graph.nodes) {
              if (p === nodePath) continue;
              const otherNode = graph.nodes.get(p)!;
              const nodeEffective = computeEffectiveAspects(otherNode, graph);
              const otherStatuses = computeEffectiveAspectStatuses(otherNode, graph);
              const shared = [...targetEffective]
                .filter((id) => nodeEffective.has(id))
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
        } catch (error) {
          debugWrite(`[impact] command failed: ${(error as Error).message}`);
          abortOnUnexpectedError(error, 'running impact');
        }
      },
    );
}
