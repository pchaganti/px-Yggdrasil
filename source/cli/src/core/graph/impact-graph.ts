import { collectAllowedReadsForAspect } from '../../structure/allowed-reads.js';
import { isPathInMapping } from '../../structure/expand-mapping-sync.js';
import { readNodeDriftState } from '../../io/drift-state-store.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from './aspects.js';
import { collectTrackedFiles } from './files.js';
import type { Graph } from '../../model/graph.js';

/**
 * Pure graph blast-radius / reverse-dependency algorithms for `yg impact`.
 *
 * These helpers take a loaded Graph (and, for the structure cascade, read the
 * persisted drift baseline through the io adapter) and return derived data with
 * no presentation or argument-parsing concerns — the CLI command handler in
 * cli/impact.ts owns output formatting. Channel/iteration order is preserved so
 * the hashed and rendered outputs stay byte-stable.
 */

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

/**
 * Find nodes whose effective structure aspect reads `repoRelative` CROSS-NODE.
 * Unified through collectTrackedFiles (precise) and collectAllowedReadsForAspect
 * (cold-start) so it cannot diverge from `yg check`'s check-touched drift.
 *   - precise (post-approve): the node's baseline records the file in
 *     identity.aspects[id].checkTouched, so collectTrackedFiles(node, graph, baseline) emits
 *     it under the 'check-touched' layer.
 *   - potential (cold-start, no identity.aspects[id].checkTouched baseline yet): the file is
 *     in the node's allowed-reads set for its structure aspect — editing it MAY
 *     cascade once the node is approved.
 * The structural owner (if any) is excluded — it is handled separately.
 */
export async function collectStructureCascade(
  graph: Graph,
  repoRelative: string,
  ownerNodePath: string | null | undefined,
): Promise<Array<{ nodePath: string; mode: 'precise' | 'potential' }>> {
  const out: Array<{ nodePath: string; mode: 'precise' | 'potential' }> = [];
  for (const [nodePath, node] of graph.nodes) {
    if (ownerNodePath && nodePath === ownerNodePath) continue;

    const baseline = await readNodeDriftState(graph.rootPath, nodePath);
    const hasStfBaseline = !!baseline && Object.values(baseline.identity.aspects)
      .some(a => a.checkTouched && Object.keys(a.checkTouched).length > 0);

    if (hasStfBaseline) {
      const { trackedFiles } = collectTrackedFiles(node, graph, baseline);
      const reads = trackedFiles.some(t => t.layer === 'check-touched' && t.path === repoRelative);
      if (reads) out.push({ nodePath, mode: 'precise' });
      continue;
    }

    // Cold start: pessimistic — does an effective non-draft deterministic aspect
    // on this node have this file in its allowed-reads set?
    const statuses = computeEffectiveAspectStatuses(node, graph);
    const hasStructureAspect = [...computeEffectiveAspects(node, graph)].some(id => {
      if (statuses.get(id) === 'draft') return false;
      return graph.aspects.find(a => a.id === id)?.reviewer.type === 'deterministic';
    });
    if (!hasStructureAspect) continue;
    const allowed = collectAllowedReadsForAspect(nodePath, graph);
    if (isPathInMapping(repoRelative, [...allowed])) {
      out.push({ nodePath, mode: 'potential' });
    }
  }
  // Code-unit comparison (locale-independent, deterministic across environments),
  // consistent with the plain .sort() calls elsewhere in this module.
  out.sort((a, b) => (a.nodePath < b.nodePath ? -1 : a.nodePath > b.nodePath ? 1 : 0));
  return out;
}
