import type { Graph, GraphNode } from '../model/graph.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';

/**
 * Computes the set of repo-relative paths a structure aspect on `nodePath`
 * is allowed to read via ctx.fs.* and ctx.graph.*. D9=A:
 *   1. own mapping minus child mapping (child wins)
 *   2. declared relation target mappings + their transitive descendants
 *      (covers port owners — port is on target)
 *   3. ancestor mappings
 *   4. descendant mappings
 *
 * Mapping entries are stored as literal file or directory paths (per the
 * normalizeMappingPaths convention in io/paths.ts). Membership tests against
 * the returned set use isPathInMapping for prefix semantics.
 *
 * Child wins rule: when the parent's own mapping lists an entry in the same
 * directory as a direct child's entry, the child's entry takes precedence and
 * is excluded from the parent's allowed reads. This applies to step 1 (exact
 * matches) and step 4 (sibling carve-out for direct children). Grandchildren
 * and deeper descendants are never carved out.
 */
export function collectAllowedReadsForAspect(nodePath: string, graph: Graph): Set<string> {
  const allowed = new Set<string>();
  const node = graph.nodes.get(nodePath);
  if (!node) return allowed;

  const addMapping = (n: GraphNode): void => {
    const mapping = n.meta.mapping ?? [];
    for (const raw of mapping) {
      const p = normalizeMappingPath(raw);
      if (p) allowed.add(p);
    }
  };

  // Collect immediate children's explicit mapping entries (literal paths).
  const childPaths = new Set<string>();
  for (const child of node.children) {
    for (const raw of child.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p) childPaths.add(p);
    }
  }

  // 1. Own mapping minus child mapping (child wins).
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (p && !childPaths.has(p)) allowed.add(p);
  }

  // 2. Relation targets (covers port owners) + their transitive descendants.
  for (const rel of node.meta.relations ?? []) {
    const target = graph.nodes.get(rel.target);
    if (!target) continue;
    addMapping(target);
    const relStack: GraphNode[] = [...target.children];
    while (relStack.length > 0) {
      const n = relStack.pop()!;
      addMapping(n);
      relStack.push(...n.children);
    }
  }

  // 3. Ancestors
  let cursor: GraphNode | null = node.parent;
  while (cursor) {
    addMapping(cursor);
    cursor = cursor.parent;
  }

  // Determine which child paths should be carved out: those that share a
  // directory with the parent's own mappings (sibling carve-out for "child wins").
  const parentDirs = new Set<string>();
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (p) {
      const lastSlash = p.lastIndexOf('/');
      if (lastSlash > 0) {
        parentDirs.add(p.substring(0, lastSlash));
      }
    }
  }
  const siblingCarveOut = new Set<string>();
  for (const cp of childPaths) {
    const lastSlash = cp.lastIndexOf('/');
    if (lastSlash > 0) {
      const cpDir = cp.substring(0, lastSlash);
      if (parentDirs.has(cpDir)) {
        siblingCarveOut.add(cp);
      }
    }
  }

  // 4. Descendants — child wins: skip direct-child entries that share a
  // directory with parent's own mappings (sibling carve-out). Grandchildren
  // and deeper are never carved out.
  const stack: GraphNode[] = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const raw of n.meta.mapping ?? []) {
      const p = normalizeMappingPath(raw);
      if (p && !siblingCarveOut.has(p)) allowed.add(p);
    }
    stack.push(...n.children);
  }

  return allowed;
}
