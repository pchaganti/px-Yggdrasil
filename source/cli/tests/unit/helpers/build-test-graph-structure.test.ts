import { describe, it, expect, afterEach } from 'vitest';
import { buildTestGraphForStructure } from './build-test-graph-structure.js';
import { cleanupTestGraphs } from './build-test-graph.js';

describe('buildTestGraphForStructure', () => {
  afterEach(() => {
    cleanupTestGraphs();
  });

  it('populates mapping on node.meta', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'a', type: 'module', mapping: ['src/a.ts', 'src/a.test.ts'] }],
    });
    const nodeA = g.nodes.get('a');
    expect(nodeA).toBeDefined();
    expect(nodeA?.meta.mapping).toEqual(['src/a.ts', 'src/a.test.ts']);
  });

  it('populates relations on node.meta', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'a', type: 'module', relations: [{ type: 'uses', target: 'b' }] },
        { path: 'b', type: 'module' },
      ],
    });
    const nodeA = g.nodes.get('a');
    expect(nodeA).toBeDefined();
    expect(nodeA?.meta.relations).toEqual([{ type: 'uses', target: 'b' }]);
  });

  it('populates relations with consumes field', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        {
          path: 'a',
          type: 'module',
          relations: [{ type: 'uses', target: 'b', consumes: ['port1', 'port2'] }],
        },
        { path: 'b', type: 'module' },
      ],
    });
    const nodeA = g.nodes.get('a');
    expect(nodeA?.meta.relations).toEqual([
      { type: 'uses', target: 'b', consumes: ['port1', 'port2'] },
    ]);
  });

  it('populates ports on node.meta', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        {
          path: 'a',
          type: 'module',
          ports: {
            port1: {
              description: 'Test port',
              aspects: ['audit-logging'],
            },
          },
        },
      ],
    });
    const nodeA = g.nodes.get('a');
    expect(nodeA).toBeDefined();
    expect(nodeA?.meta.ports).toEqual({
      port1: {
        description: 'Test port',
        aspects: ['audit-logging'],
      },
    });
  });

  it('preserves parent-child references from buildTestGraph', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'parent', type: 'module' },
        { path: 'parent/child', type: 'module', parent: 'parent', mapping: ['src/child.ts'] },
      ],
    });
    const parent = g.nodes.get('parent');
    const child = g.nodes.get('parent/child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.parent).toBe(parent);
    expect(parent?.children).toContain(child!);
    expect(child?.meta.mapping).toEqual(['src/child.ts']);
  });

  it('handles multiple aspects, relations, and ports together', () => {
    const g = buildTestGraphForStructure({
      aspects: [
        { id: 'audit-logging' },
        { id: 'input-validation' },
      ],
      nodes: [
        {
          path: 'a',
          type: 'module',
          aspects: ['audit-logging'],
          mapping: ['src/a.ts'],
          relations: [
            { type: 'calls', target: 'b' },
            { type: 'uses', target: 'c', consumes: ['port1'] },
          ],
          ports: {
            port1: {
              description: 'API port',
              aspects: ['input-validation'],
            },
          },
        },
        { path: 'b', type: 'module' },
        { path: 'c', type: 'module' },
      ],
    });
    const nodeA = g.nodes.get('a');
    expect(nodeA).toBeDefined();
    expect(nodeA?.meta.aspects).toEqual(['audit-logging']);
    expect(nodeA?.meta.mapping).toEqual(['src/a.ts']);
    expect(nodeA?.meta.relations).toHaveLength(2);
    expect(nodeA?.meta.relations?.[0]).toEqual({ type: 'calls', target: 'b' });
    expect(nodeA?.meta.relations?.[1]).toEqual({
      type: 'uses',
      target: 'c',
      consumes: ['port1'],
    });
    expect(nodeA?.meta.ports).toBeDefined();
    expect(nodeA?.meta.ports?.port1.aspects).toEqual(['input-validation']);
  });
});
