import type { GraphNode } from '../../model/graph.js';

/**
 * Return the chain of ancestors from the root down to the immediate parent.
 * Root-first ordering. Does NOT include the input node.
 * Returns an empty array for a node with no parent.
 */
export function collectAncestors(node: GraphNode): GraphNode[] {
  const ancestors: GraphNode[] = [];
  let current = node.parent;
  while (current) {
    ancestors.unshift(current);
    current = current.parent;
  }
  return ancestors;
}

/**
 * Return every descendant in breadth-first order.
 * Does NOT include the input node.
 * Returns an empty array for a leaf.
 */
export function collectDescendants(node: GraphNode): GraphNode[] {
  const out: GraphNode[] = [];
  const queue: GraphNode[] = [...node.children];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    out.push(curr);
    for (const c of curr.children) queue.push(c);
  }
  return out;
}
