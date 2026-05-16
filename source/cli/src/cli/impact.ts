import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraphOrAbort } from '../formatters/cli-preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { collectAncestors } from '../core/context-builder.js';
import { computeEffectiveAspects } from '../core/effective-aspects.js';
import { findOwner } from './owner.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { evaluateFileWhen } from '../core/file-when-evaluator.js';
import type { Graph } from '../model/graph.js';

const STRUCTURAL_TYPES = new Set(['uses', 'calls', 'extends', 'implements']);

export function collectReverseDependents(
  graph: Graph,
  targetNode: string,
): {
  direct: string[];
  allDependents: string[];
  reverse: Map<string, Set<string>>;
  relationFrom: Map<string, { type: string; consumes?: string[] }>;
} {
  const reverse = new Map<string, Set<string>>();
  const relationFrom = new Map<string, { type: string; consumes?: string[] }>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type)) continue;
      const deps = reverse.get(rel.target) ?? new Set<string>();
      deps.add(nodePath);
      reverse.set(rel.target, deps);
      relationFrom.set(`${nodePath}->${rel.target}`, {
        type: rel.type,
        consumes: rel.consumes,
      });
    }
  }

  const direct = [...(reverse.get(targetNode) ?? [])].sort();
  const seen = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return {
    direct,
    allDependents: [...seen].sort(),
    reverse,
    relationFrom,
  };
}

export function buildTransitiveChains(
  targetNode: string,
  direct: string[],
  allDependents: string[],
  reverse: Map<string, Set<string>>,
): string[] {
  const directSet = new Set(direct);
  const transitiveOnly = allDependents.filter((t) => !directSet.has(t));
  if (transitiveOnly.length === 0) return [];

  const parent = new Map<string, string>();
  const queue: string[] = [targetNode];
  const visited = new Set<string>([targetNode]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of reverse.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      queue.push(next);
    }
  }

  const chains: string[] = [];
  for (const node of transitiveOnly) {
    const path: string[] = [];
    let current: string | undefined = node;
    while (current) {
      path.unshift(current);
      current = parent.get(current);
    }
    if (path.length >= 3) {
      chains.push(path.slice(1).map((p) => `<- ${p}`).join(' '));
    }
  }
  return chains.sort();
}

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

export function collectIndirectDependents(
  graph: Graph,
  directlyAffected: string[],
): { indirectPaths: string[]; chains: string[] } {
  const directSet = new Set(directlyAffected);

  // Build reverse adjacency map once (structural + event relations)
  const reverse = new Map<string, Set<string>>();
  for (const [nodePath, node] of graph.nodes) {
    for (const rel of node.meta.relations ?? []) {
      if (!STRUCTURAL_TYPES.has(rel.type) && rel.type !== 'emits' && rel.type !== 'listens') continue;
      const deps = reverse.get(rel.target) ?? new Set<string>();
      deps.add(nodePath);
      reverse.set(rel.target, deps);
    }
  }

  // For each affected node, BFS to find reverse dependents and build chains
  const bestChain = new Map<string, { chain: string; depth: number }>();

  for (const affected of directlyAffected) {
    const parent = new Map<string, string>();
    const queue = [affected];
    const visited = new Set([affected]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of reverse.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        parent.set(next, current);
        queue.push(next);
      }
    }

    for (const [node] of parent) {
      if (directSet.has(node)) continue;

      // Trace path from node back to affected
      const path: string[] = [node];
      let current = node;
      while (parent.has(current)) {
        current = parent.get(current)!;
        path.push(current);
      }

      const chain = path.map((p) => `<- ${p}`).join(' ');
      const depth = path.length;

      const existing = bestChain.get(node);
      if (!existing || depth < existing.depth) {
        bestChain.set(node, { chain, depth });
      }
    }
  }

  const indirectPaths = [...bestChain.keys()].sort();
  const chains = indirectPaths.map((p) => bestChain.get(p)!.chain);
  return { indirectPaths, chains };
}

async function handleAspectImpact(
  graph: Graph,
  aspectId: string,
): Promise<void> {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    process.stderr.write(chalk.red(buildIssueMessage({
      what: `Aspect not found: ${aspectId}`,
      why: 'The aspect id must match a directory name under .yggdrasil/aspects/.',
      next: 'Run: yg aspects — to list all defined aspects.',
    }) + '\n'));
    process.exit(1);
  }

  const affected: Array<{ path: string; source: string }> = [];
  for (const [nodePath, node] of graph.nodes) {
    const effective = computeEffectiveAspects(node, graph);
    if (effective.has(aspectId)) {
      const ownAspectIds = new Set(node.meta.aspects ?? []);
      if (ownAspectIds.has(aspectId)) {
        affected.push({ path: nodePath, source: 'own' });
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
          affected.push({ path: nodePath, source: `hierarchy from ${anc!.path}` });
        } else {
          const ancestorPaths = new Set([nodePath, ...collectAncestors(node).map((a) => a.path)]);
          const flow = graph.flows.find(
            (f) =>
              (f.aspects ?? []).includes(aspectId) &&
              f.nodes.some((n) => ancestorPaths.has(n)),
          );
          affected.push({ path: nodePath, source: flow ? `flow: ${flow.name}` : 'implied' });
        }
      }
    }
  }

  affected.sort((a, b) => a.path.localeCompare(b.path));

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

  process.stdout.write(`Impact of changes in aspect ${aspectId}:\n\n`);
  process.stdout.write(`Directly affected (${affected.length}):\n`);
  if (affected.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const { path: p, source } of affected) {
      process.stdout.write(`  ${p} (${source})\n`);
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
  process.stdout.write(`  All ${affected.length} directly affected nodes would show upstream-drift if this aspect changes.\n`);
  const totalAffected = affected.length + indirectPaths.length;
  if (totalAffected >= 10) {
    process.stdout.write(`  High blast radius — review aspect requirements in affected nodes before modifying this aspect.\n`);
  }

}

async function handleFlowImpact(
  graph: Graph,
  flowName: string,
): Promise<void> {
  const flow = graph.flows.find((f) => f.name === flowName || f.path === flowName);
  if (!flow) {
    process.stderr.write(chalk.red(buildIssueMessage({
      what: `Flow not found: ${flowName}`,
      why: 'The flow name must match a directory name under .yggdrasil/flows/.',
      next: 'Run: yg flows — to list all defined flows.',
    }) + '\n'));
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
  process.stdout.write(`  All ${declaredParticipants.length} participants would show upstream-drift if this flow changes.\n`);
  const totalFlowAffected = sorted.length + indirectPaths.length;
  if (totalFlowAffected >= 10) {
    process.stdout.write(`  High blast radius — review flow compliance in participants before modifying.\n`);
  }

}

async function handleTypeImpact(graph: Graph, typeId: string): Promise<void> {
  const def = graph.architecture.node_types[typeId];
  if (!def) {
    process.stderr.write(chalk.red(buildIssueMessage({
      what: `Type '${typeId}' not found in architecture.`,
      why: 'The type id must match a node_types key in .yggdrasil/yg-architecture.yaml.',
      next: 'Read .yggdrasil/yg-architecture.yaml to see defined types.',
    }) + '\n'));
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
            process.stderr.write(chalk.red("Error: '--node' and '--file' are mutually exclusive\n"));
            process.exit(1);
          }

          const modeCount = [options.node || options.file, options.aspect, options.flow, options.type].filter(Boolean).length;
          if (modeCount === 0) {
            process.stderr.write(
              chalk.red('Error: one of --node, --file, --aspect, --flow, or --type is required\n'),
            );
            process.exit(1);
          }
          if (modeCount > 1) {
            process.stderr.write(
              chalk.red('Error: --node/--file, --aspect, --flow, and --type are mutually exclusive\n'),
            );
            process.exit(1);
          }

          const graph = await loadGraphOrAbort(process.cwd());
          initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);

          // Resolve --file to --node
          if (options.file) {
            const repoRoot = projectRootFromGraph(graph.rootPath);
            const repoRelative = resolveFileArg(repoRoot, options.file);
            const result = findOwner(graph, repoRoot, repoRelative);
            if (!result.nodePath) {
              process.stderr.write(chalk.red(buildIssueMessage({
                what: `${result.file.replace(/\\/g, '/').replace(/\/+$/, '')} -> no graph coverage`,
                why: 'File is not mapped to any node in the graph.',
                next: 'Add the file to an existing node mapping, or create a new node.',
              }) + '\n'));
              process.exit(1);
            }
            process.stderr.write(`${result.file} -> ${result.nodePath}\n`);
            options.node = result.nodePath;
          }

          if (options.aspect) {
            await handleAspectImpact(graph, options.aspect.trim());
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
            process.stderr.write(chalk.red(buildIssueMessage({
              what: `Node not found: ${nodePath}`,
              why: 'The node path must match a node in the graph.',
              next: 'Run: yg tree — to list all nodes.',
            }) + '\n'));
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

          const targetEffective = computeEffectiveAspects(graph.nodes.get(nodePath)!, graph);
          const aspectsInScope: string[] = [];
          for (const aspect of graph.aspects) {
            if (targetEffective.has(aspect.id)) {
              aspectsInScope.push(aspect.name);
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
            for (const { path: p, type, eventName } of eventDependents.sort((a, b) => a.path.localeCompare(b.path))) {
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
              const nodeEffective = computeEffectiveAspects(graph.nodes.get(p)!, graph);
              const shared = [...targetEffective].filter((id) => nodeEffective.has(id));
              if (shared.length > 0) {
                coAspectNodes.push({ path: p, shared });
              }
            }
          }
          if (coAspectNodes.length > 0) {
            process.stdout.write('Nodes sharing aspects:\n');
            for (const { path: p, shared } of coAspectNodes.sort((a, b) =>
              a.path.localeCompare(b.path),
            )) {
              process.stdout.write(`  ${p} (${shared.join(', ')})\n`);
            }
          }

          const allAffected = new Set([...allDependents, ...descendants, ...eventDependents.map((e) => e.path), ...descIndirectPaths]);
          process.stdout.write(
            `\nBlast radius: ${allAffected.size} nodes, ${flows.length} flows, ${aspectsInScope.length} aspects\n`,
          );
          process.stdout.write(
            `  All ${allAffected.size} nodes would show upstream-drift (cascade drift) if this node changes.\n`,
          );
          if (allAffected.size >= 10) {
            process.stdout.write(`  High blast radius — review direct dependents before changing this node.\n`);
          } else if (allAffected.size > 0) {
            process.stdout.write(`  Review direct dependents before changing this node.\n`);
          }
        } catch (error) {
          debugWrite(`[impact] command failed: ${(error as Error).message}`);
          process.stderr.write(chalk.red(`Error: ${(error as Error).message}\n`));
          process.exit(1);
        }
      },
    );
}
