import type { Graph, NodeMeta, Relation, PortDef, RelationType } from '../../../src/model/graph.js';
import { buildTestGraph, type TestNodeInput, type TestAspectInput, type TestTypeInput } from './build-test-graph.js';

/**
 * Test-helper input for a node. Public-helper convention (inherited from
 * buildTestGraph): `parent` here is a STRING — the path of the parent node.
 * buildTestGraph resolves it into an object reference (GraphNode | null) on
 * the materialized GraphNode during a second pass, matching the runtime
 * graph shape where `GraphNode.parent: GraphNode | null` is an object ref.
 * Do not pass an object here; that is the internal shape, not the helper API.
 */
export interface StructureNodeInput extends TestNodeInput {
  mapping?: string[];
  relations?: Array<{ type: RelationType; target: string; consumes?: string[] }>;
  ports?: Record<string, PortDef>;
}

export interface StructureGraphInput {
  aspects?: TestAspectInput[];
  nodes?: StructureNodeInput[];
  types?: TestTypeInput[];
  rootPath?: string;
}

export function buildTestGraphForStructure(input: StructureGraphInput): Graph {
  const graph = buildTestGraph({
    aspects: input.aspects,
    nodes: input.nodes,
    types: input.types,
    rootPath: input.rootPath,
  });
  // Patch meta with mapping/relations/ports
  for (const inputNode of input.nodes ?? []) {
    const n = graph.nodes.get(inputNode.path);
    if (!n) continue;
    if (inputNode.mapping) (n.meta as NodeMeta).mapping = inputNode.mapping;
    if (inputNode.relations) (n.meta as NodeMeta).relations = inputNode.relations as Relation[];
    if (inputNode.ports) (n.meta as NodeMeta).ports = inputNode.ports;
  }
  return graph;
}
