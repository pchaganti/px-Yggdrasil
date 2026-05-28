import type {
  Graph, GraphNode, AspectDef, FlowDef, YggConfig, ArchitectureDef,
  ArchitectureNodeType, AspectStatus, StatusInherit,
} from '../../../src/model/graph.js';

export interface TestAspectInput {
  id: string;
  status?: AspectStatus;
  implies?: string[];
  impliesStatusInherit?: Record<string, StatusInherit>;
}
export interface TestNodeInput {
  path: string;
  type: string;
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
  parent?: string;
}
export interface TestFlowInput {
  path: string;
  nodes: string[];
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
}
export interface TestTypeInput {
  id: string;
  description?: string;
  aspects?: string[];
  aspectStatus?: Record<string, AspectStatus>;
}

const EMPTY_CONFIG: YggConfig = {
  version: '5.0.0',
  reviewer: { tiers: { default: { provider: 'ollama', model: 'test', temperature: 0, consensus: 1, max_tokens: 'auto' } }, default: 'default' },
};

export function buildTestGraph(input: {
  aspects?: TestAspectInput[];
  nodes?: TestNodeInput[];
  flows?: TestFlowInput[];
  types?: TestTypeInput[];
  config?: YggConfig;
  rootPath?: string;
}): Graph {
  const aspects: AspectDef[] = (input.aspects ?? []).map(a => ({
    id: a.id, name: a.id, reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status: a.status, implies: a.implies, impliesStatusInherit: a.impliesStatusInherit,
  } as AspectDef));

  const nodeByPath = new Map<string, GraphNode>();
  for (const n of input.nodes ?? []) {
    nodeByPath.set(n.path, {
      path: n.path,
      meta: { name: n.path, type: n.type, aspects: n.aspects, aspectStatus: n.aspectStatus },
      children: [], parent: null,
    } as GraphNode);
  }
  for (const n of input.nodes ?? []) {
    if (n.parent) {
      const child = nodeByPath.get(n.path)!;
      const parent = nodeByPath.get(n.parent)!;
      child.parent = parent;
      parent.children.push(child);
    }
  }

  const flows: FlowDef[] = (input.flows ?? []).map(f => ({
    path: f.path, name: f.path, nodes: f.nodes, aspects: f.aspects, aspectStatus: f.aspectStatus,
  } as FlowDef));

  const node_types: Record<string, ArchitectureNodeType> = {};
  node_types.service = { description: 'test service type' };
  node_types.module = { description: 'test module type' };
  for (const t of input.types ?? []) {
    node_types[t.id] = {
      description: t.description ?? `test ${t.id}`,
      aspects: t.aspects, aspectStatus: t.aspectStatus,
    };
  }
  const architecture: ArchitectureDef = { node_types };

  return {
    config: input.config ?? EMPTY_CONFIG,
    architecture,
    nodes: nodeByPath,
    flows,
    aspects,
    rootPath: input.rootPath ?? '/tmp/test-graph',
  } as unknown as Graph;
}
