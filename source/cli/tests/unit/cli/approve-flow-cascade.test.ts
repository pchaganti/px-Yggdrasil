import { describe, it, expect } from 'vitest';
import { filterFlowCascadeNodes } from '../../../src/cli/approve.js';
import type { CheckIssue } from '../../../src/core/check.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';

describe('filterFlowCascadeNodes', () => {
  // Minimal graph: flow 'checkout' declares participants 'orders/handler' and 'orders'.
  // 'orders/sub' is a child of 'orders' (declared) → participates by descendant inclusion.
  // 'billing/x' participates in no flow.
  const P = { path: 'orders', parent: undefined, children: [] } as unknown as GraphNode;
  const N = { path: 'orders/handler', parent: undefined, children: [] } as unknown as GraphNode;
  const C = { path: 'orders/sub', parent: P, children: [] } as unknown as GraphNode;
  const B = { path: 'billing/x', parent: undefined, children: [] } as unknown as GraphNode;
  const graph = {
    nodes: new Map<string, GraphNode>([[P.path, P], [N.path, N], [C.path, C], [B.path, B]]),
    flows: [{ path: 'checkout', name: 'checkout', nodes: ['orders/handler', 'orders'] }],
  } as unknown as Graph;

  const cascade = (nodePath: string, causeFile: string): CheckIssue => ({
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: { what: 'cascade', why: '', next: '' },
    nodePath,
    cascadeCauses: [{ file: causeFile, layer: 'aspects' as const, description: '' }],
  });

  it('selects a flow participant with cascade drift even when the cause lives under aspects/ (not flows/)', () => {
    const issues = [cascade('orders/handler', '.yggdrasil/aspects/deterministic/content.md')];
    expect(filterFlowCascadeNodes(issues, graph, 'checkout')).toEqual(['orders/handler']);
  });

  it('includes a descendant of a declared participant', () => {
    const issues = [cascade('orders/sub', '.yggdrasil/aspects/deterministic/content.md')];
    expect(filterFlowCascadeNodes(issues, graph, 'checkout')).toEqual(['orders/sub']);
  });

  it('excludes a cascade-drifted node that does not participate in the flow', () => {
    const issues = [cascade('billing/x', '.yggdrasil/aspects/deterministic/content.md')];
    expect(filterFlowCascadeNodes(issues, graph, 'checkout')).toEqual([]);
  });

  it('ignores non-upstream-drift issues', () => {
    const issues: CheckIssue[] = [{
      severity: 'error',
      code: 'source-drift',
      rule: 'direct-drift',
      messageData: { what: 'direct', why: '', next: '' },
      nodePath: 'orders/handler',
    }];
    expect(filterFlowCascadeNodes(issues, graph, 'checkout')).toEqual([]);
  });
});
