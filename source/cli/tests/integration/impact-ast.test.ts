import { describe, it, expect } from 'vitest';
import type { Graph, GraphNode } from '../../src/model/graph.js';
import { computeEffectiveAspects } from '../../src/core/graph/aspects.js';

describe('yg impact --aspect cascade scope (regression)', () => {
  it('AST aspect cascade equals LLM aspect cascade for identical node attachment', () => {
    // Two aspects with identical own-attachment on the same nodes.
    // One is AST reviewer, one is LLM reviewer.
    // Their cascade scope (nodes for which computeEffectiveAspects includes them)
    // must be identical — the reviewer field does not affect cascade logic.

    const nodeA: GraphNode = {
      path: 'svc-a',
      meta: { name: 'SvcA', type: 'service', aspects: ['llm-aspect', 'ast-aspect'] },
      children: [],
      parent: null,
    };
    const nodeB: GraphNode = {
      path: 'svc-b',
      meta: { name: 'SvcB', type: 'service', aspects: [] },
      children: [],
      parent: null,
    };

    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['svc-a', nodeA],
        ['svc-b', nodeB],
      ]),
      aspects: [
        { id: 'llm-aspect', name: 'LLM Aspect', reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: '# rule' }] },
        { id: 'ast-aspect', name: 'AST Aspect', reviewer: { type: 'deterministic' as const }, artifacts: [{ filename: 'check.mjs', content: 'export function check(ctx){return[];}' }] },
      ],
      flows: [],
      schemas: [],
      rootPath: '/fake/.yggdrasil',
    };

    // Collect affected nodes for each aspect
    const llmAffected: string[] = [];
    const astAffected: string[] = [];

    for (const [nodePath, node] of graph.nodes) {
      const effective = computeEffectiveAspects(node, graph);
      if (effective.has('llm-aspect')) llmAffected.push(nodePath);
      if (effective.has('ast-aspect')) astAffected.push(nodePath);
    }

    llmAffected.sort();
    astAffected.sort();

    // Same attachment → same cascade scope
    expect(astAffected).toEqual(llmAffected);
  });

  it('AST aspect on parent cascades to child nodes identically to LLM', () => {
    const parent: GraphNode = {
      path: 'orders',
      meta: { name: 'Orders', type: 'module', aspects: ['llm-parent', 'ast-parent'] },
      children: [],
      parent: null,
    };
    const child: GraphNode = {
      path: 'orders/service',
      meta: { name: 'Service', type: 'service', aspects: [] },
      children: [],
      parent,
    };
    parent.children = [child];

    const graph: Graph = {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([
        ['orders', parent],
        ['orders/service', child],
      ]),
      aspects: [
        { id: 'llm-parent', name: 'LLM Parent', reviewer: { type: 'llm' as const }, artifacts: [{ filename: 'content.md', content: '' }] },
        { id: 'ast-parent', name: 'AST Parent', reviewer: { type: 'deterministic' as const }, artifacts: [{ filename: 'check.mjs', content: 'export function check(ctx){return[];}' }] },
      ],
      flows: [],
      schemas: [],
      rootPath: '/fake/.yggdrasil',
    };

    const llmAffected: string[] = [];
    const astAffected: string[] = [];

    for (const [nodePath, node] of graph.nodes) {
      const effective = computeEffectiveAspects(node, graph);
      if (effective.has('llm-parent')) llmAffected.push(nodePath);
      if (effective.has('ast-parent')) astAffected.push(nodePath);
    }

    llmAffected.sort();
    astAffected.sort();

    // Both should cascade to child node
    expect(astAffected).toEqual(llmAffected);
    expect(astAffected).toContain('orders/service');
  });
});
