import { describe, it, expect } from 'vitest';
import { computeEffectiveAspectStatuses } from '../../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef, ArchitectureDef, FlowDef } from '../../../../src/model/graph.js';
import type { WhenPredicate } from '../../../../src/model/when.js';

// Test-file-local convenience helpers. Tasks 12/24.7 use the shared buildTestGraph helper.
function makeAspect(id: string, status: 'draft' | 'advisory' | 'enforced' = 'enforced', extra: Partial<AspectDef> = {}): AspectDef {
  return {
    id, name: id, reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
    ...extra,
  } as AspectDef;
}

function makeNode(path: string, type: string, aspects: string[] = [], aspectStatus?: Record<string, 'draft' | 'advisory' | 'enforced'>): GraphNode {
  return {
    path, meta: { name: path, type, aspects, aspectStatus }, children: [], parent: null,
  } as GraphNode;
}

function makeGraph(aspects: AspectDef[], nodes: GraphNode[] = []): Graph {
  return {
    aspects, nodes: new Map(nodes.map(n => [n.path, n])), flows: [], architecture: null,
  } as unknown as Graph;
}

describe('computeEffectiveAspectStatuses — channels 1–6', () => {
  it('absent aspect default → effective enforced', () => {
    const aspect: AspectDef = { ...makeAspect('a', 'enforced'), status: undefined } as AspectDef;
    const node = makeNode('n', 'service', ['a']);
    const result = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(result.get('a')).toBe('enforced');
  });

  it('aspect-default advisory + no override → advisory', () => {
    const node = makeNode('n', 'service', ['a']);
    const result = computeEffectiveAspectStatuses(node, makeGraph([makeAspect('a', 'advisory')], [node]));
    expect(result.get('a')).toBe('advisory');
  });

  it('attach-site override raises status (bump)', () => {
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    const result = computeEffectiveAspectStatuses(node, makeGraph([makeAspect('a', 'advisory')], [node]));
    expect(result.get('a')).toBe('enforced');
  });

  it('strictest wins across two channels both providing the aspect', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'enforced' });
    const child = makeNode('p/c', 'service', ['a']);
    child.parent = parent;
    parent.children = [child];
    const result = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child]));
    expect(result.get('a')).toBe('enforced');
  });

  it('channel 3 — own architecture type aspect contributes status', () => {
    const aspect = makeAspect('a', 'draft');
    const node = makeNode('n', 'service');
    const architecture: ArchitectureDef = {
      node_types: {
        service: {
          description: 'svc',
          aspects: ['a'],
          aspectStatus: { a: 'advisory' },
        },
      },
    };
    const graph = makeGraph([aspect], [node]);
    (graph as unknown as { architecture: ArchitectureDef }).architecture = architecture;
    const result = computeEffectiveAspectStatuses(node, graph);
    expect(result.get('a')).toBe('advisory');
  });

  it('channel 4 — ancestor architecture type aspect contributes status', () => {
    const aspect = makeAspect('a', 'draft');
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    child.parent = parent;
    parent.children = [child];
    const architecture: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['a'], aspectStatus: { a: 'enforced' } },
        service: { description: 'svc' },
      },
    };
    const graph = makeGraph([aspect], [parent, child]);
    (graph as unknown as { architecture: ArchitectureDef }).architecture = architecture;
    const result = computeEffectiveAspectStatuses(child, graph);
    expect(result.get('a')).toBe('enforced');
  });

  it('channel 5 — flow aspect contributes status (direct and via ancestor)', () => {
    const aspect = makeAspect('a', 'draft');
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    child.parent = parent;
    parent.children = [child];
    const flowDirect: FlowDef = { path: 'f1', name: 'f1', nodes: ['p/c'], aspects: ['a'], aspectStatus: { a: 'advisory' } } as FlowDef;
    const flowAncestor: FlowDef = { path: 'f2', name: 'f2', nodes: ['p'], aspects: ['a'], aspectStatus: { a: 'enforced' } } as FlowDef;
    const flowUnrelated: FlowDef = { path: 'f3', name: 'f3', nodes: ['other'], aspects: ['a'], aspectStatus: { a: 'enforced' } } as FlowDef;
    const graph = makeGraph([aspect], [parent, child]);
    (graph as unknown as { flows: FlowDef[] }).flows = [flowDirect, flowAncestor, flowUnrelated];
    const result = computeEffectiveAspectStatuses(child, graph);
    expect(result.get('a')).toBe('enforced');
  });

  it('channel 6 — port aspect on consumed relation contributes status', () => {
    const aspect = makeAspect('a', 'draft');
    const target: GraphNode = {
      path: 'svc',
      meta: {
        name: 'svc', type: 'service',
        ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'advisory' } } },
      },
      children: [], parent: null,
    } as GraphNode;
    const consumer: GraphNode = {
      path: 'c',
      meta: {
        name: 'c', type: 'service',
        relations: [{ target: 'svc', type: 'calls', consumes: ['p'] }],
      },
      children: [], parent: null,
    } as GraphNode;
    const result = computeEffectiveAspectStatuses(consumer, makeGraph([aspect], [target, consumer]));
    expect(result.get('a')).toBe('advisory');
  });

  it('channel 6 — relation without consumes does not contribute', () => {
    const aspect = makeAspect('a', 'advisory');
    const target: GraphNode = {
      path: 'svc',
      meta: {
        name: 'svc', type: 'service',
        ports: { p: { description: '', aspects: ['a'] } },
      },
      children: [], parent: null,
    } as GraphNode;
    const consumer: GraphNode = {
      path: 'c',
      meta: { name: 'c', type: 'service', relations: [{ target: 'svc', type: 'calls' }] },
      children: [], parent: null,
    } as GraphNode;
    const result = computeEffectiveAspectStatuses(consumer, makeGraph([aspect], [target, consumer]));
    expect(result.has('a')).toBe(false);
  });

  it('channel 6 — relation target missing or no ports does not throw', () => {
    const aspect = makeAspect('a', 'advisory');
    const consumer: GraphNode = {
      path: 'c',
      meta: { name: 'c', type: 'service', relations: [{ target: 'missing', type: 'calls', consumes: ['p'] }] },
      children: [], parent: null,
    } as GraphNode;
    const result = computeEffectiveAspectStatuses(consumer, makeGraph([aspect], [consumer]));
    expect(result.has('a')).toBe(false);
  });

  it('global when=false on aspect suppresses contribution from all channels', () => {
    const falseWhen: WhenPredicate = { all_of: [{ node: { type: 'nonexistent' } }] } as WhenPredicate;
    const aspect: AspectDef = { ...makeAspect('a', 'enforced'), when: falseWhen } as AspectDef;
    const node = makeNode('n', 'service', ['a']);
    const result = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(result.has('a')).toBe(false);
  });

  it('attach-site when=false on own channel suppresses status', () => {
    const falseWhen: WhenPredicate = { all_of: [{ node: { type: 'nonexistent' } }] } as WhenPredicate;
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    node.meta.aspectWhens = { a: falseWhen };
    const result = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(result.has('a')).toBe(false);
  });

  it('aspect with no def in graph.aspects falls back to enforced default', () => {
    const node = makeNode('n', 'service', ['orphan']);
    const result = computeEffectiveAspectStatuses(node, makeGraph([], [node]));
    expect(result.get('orphan')).toBe('enforced');
  });

  it('node with no own aspects and no ancestors yields empty result', () => {
    const node = makeNode('n', 'service');
    const result = computeEffectiveAspectStatuses(node, makeGraph([], [node]));
    expect(result.size).toBe(0);
  });
});
