import chalk from 'chalk';
import { join } from 'node:path';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { collectAncestors } from '../core/context-builder.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../core/graph/aspects.js';
import {
  collectIndirectDependents,
  nodesWithRefusedVerdict,
} from '../core/graph/impact-graph.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { evaluateFileWhen } from '../core/file-when-evaluator.js';
import { computeExpectedPairs } from '../core/pairs.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import type { Graph } from '../model/graph.js';
import type { LockFile } from '../model/lock.js';

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

export async function handleAspectImpact(
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
  process.stdout.write(
    `\nNext: weigh the cost above before editing the aspect, then run yg check --approve to re-verify the affected pairs.\n`,
  );
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
export async function computeAspectFillCost(graph: Graph, aspectId: string): Promise<FillCost> {
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
export function renderFillCost(cost: FillCost, affectedNodes: number): string {
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

export async function handleFlowImpact(
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
  process.stdout.write(
    `\nNext: review the participants above before editing the flow, then run yg check --approve to re-verify them.\n`,
  );
}

export async function handleTypeImpact(graph: Graph, typeId: string): Promise<void> {
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
  process.stdout.write(
    `\nNext: review the nodes of this type above before editing the type's defaults or when predicate, then run yg check --approve.\n`,
  );
}
