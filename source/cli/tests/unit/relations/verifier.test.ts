import { describe, it, expect } from 'vitest';
import { verifyNodeDeps } from '../../../src/relations/verifier.js';

const graph = {
  isAncestorOf: (a: string, b: string) => b.startsWith(a + '/'),
  declaredTargets: (n: string) => (n === 'orders/handler' ? new Set(['payments/service']) : new Set<string>()),
  parentChain: (n: string) => { const out: string[] = []; let p = n; while (p.includes('/')) { p = p.slice(0, p.lastIndexOf('/')); out.push(p); } return out; },
};

describe('verifyNodeDeps', () => {
  it('flags an undeclared cross-node dep on a mapped target', () => {
    const v = verifyNodeDeps('orders/handler', [{ fromFile: 'src/o.ts', line: 3, ownerNode: 'billing/svc' }], graph as any);
    expect(v).toHaveLength(1);
    expect(v[0].ownerNode).toBe('billing/svc');
  });
  it('does NOT flag a declared dep', () => {
    expect(verifyNodeDeps('orders/handler', [{ fromFile: 'src/o.ts', line: 3, ownerNode: 'payments/service' }], graph as any)).toHaveLength(0);
  });
  it('does NOT flag intra-node, ancestor, or descendant', () => {
    const deps = [
      { fromFile: 'f', line: 1, ownerNode: 'orders/handler' },
      { fromFile: 'f', line: 2, ownerNode: 'orders' },
      { fromFile: 'f', line: 3, ownerNode: 'orders/handler/sub' },
    ];
    expect(verifyNodeDeps('orders/handler', deps, graph as any)).toHaveLength(0);
  });
  it('a relation to an ancestor of the target sanctions the dep', () => {
    const g2 = { ...graph, declaredTargets: () => new Set(['payments']) };
    const dep = [{ fromFile: 'f', line: 9, ownerNode: 'payments/service' }];
    expect(verifyNodeDeps('orders/handler', dep, g2 as any)).toHaveLength(0);
  });
});
