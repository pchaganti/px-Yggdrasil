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
 * Child wins rule: when the parent's own mapping explicitly lists a file F,
 * any sibling file in the same directory that is exclusively mapped by a
 * direct child node is carved out — the child owns it. This applies to the
 * parent's own mapping entries (step 1) and descendant step (step 4).
 * When the parent maps only directory entries (no explicit files within those
 * directories), descendant mappings are included without carve-out.
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

  // Compute "sibling carve-out" set: child paths that are siblings of explicit
  // file entries in the parent's own mapping. When the parent explicitly lists
  // a file under a directory it maps, it signals selective enumeration — child
  // entries in the same directory take precedence (child wins).
  const ownFileDirs = new Set<string>();
  for (const raw of node.meta.mapping ?? []) {
    const p = normalizeMappingPath(raw);
    if (!p) continue;
    const lastSegment = p.substring(p.lastIndexOf('/') + 1);
    if (lastSegment.includes('.')) {
      // Looks like a file path — record its parent directory.
      const dir = p.substring(0, p.lastIndexOf('/'));
      if (dir) ownFileDirs.add(dir);
    }
  }
  // Child mapping entries that are siblings of parent's explicit files → excluded.
  const siblingCarveOut = new Set<string>();
  for (const cp of childPaths) {
    const lastSlash = cp.lastIndexOf('/');
    if (lastSlash > 0) {
      const dir = cp.substring(0, lastSlash);
      if (ownFileDirs.has(dir)) {
        siblingCarveOut.add(cp);
      }
    }
  }

  // 1. Own mapping minus child carve-out (literal exact match on childPaths).
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

  // 4. Descendants — add all descendant node mappings; skip entries that are
  // siblings of the parent's own explicit files (siblingCarveOut).
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
