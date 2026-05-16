import type { Graph, GraphNode, FlowDef } from '../../model/graph.js';
import { collectAncestors } from './traversal.js';

/**
 * Return every flow that includes the given node or any of its ancestors
 * in its `nodes` participation list. Order is the order of flows in the graph.
 */
export function collectParticipatingFlows(graph: Graph, node: GraphNode): FlowDef[] {
  const paths = new Set<string>([node.path, ...collectAncestors(node).map((a) => a.path)]);
  return graph.flows.filter((f) => f.nodes.some((n) => paths.has(n)));
}
