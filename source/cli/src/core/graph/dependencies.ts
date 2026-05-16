import type { Graph, GraphNode, YggConfig } from '../../model/graph.js';
import { collectAncestors } from './traversal.js';
import { computeEffectiveAspects } from '../effective-aspects.js';

export interface DependencyAncestorInfo {
  path: string;
  name: string;
  type: string;
  aspects: string[];
}

/**
 * Return the ancestor chain enriched with metadata and the effective aspect
 * set computed for each ancestor. Root-first ordering inherited from
 * collectAncestors.
 */
export function collectDependencyAncestors(
  target: GraphNode,
  _config: YggConfig,
  graph: Graph,
): DependencyAncestorInfo[] {
  const ancestors = collectAncestors(target);
  return ancestors.map((ancestor) => {
    const effectiveIds = computeEffectiveAspects(ancestor, graph);
    return {
      path: ancestor.path,
      name: ancestor.meta.name,
      type: ancestor.meta.type,
      aspects: [...effectiveIds],
    };
  });
}
