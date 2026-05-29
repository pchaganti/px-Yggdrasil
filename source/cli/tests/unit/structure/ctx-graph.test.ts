import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCtxGraph, UndeclaredGraphReadError } from '../../../src/structure/ctx-graph.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';
import { cleanupTestGraphs } from '../helpers/build-test-graph.js';

describe('ctx.graph', () => {
  let projectRoot: string;
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); cleanupTestGraphs(); });

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-ctx-graph-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/a.ts'), 'a');
    writeFileSync(path.join(projectRoot, 'src/b.ts'), 'b');
    writeFileSync(path.join(projectRoot, 'src/c.ts'), 'c');
  });

  it('node() returns relation target as public GraphNode', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/b.ts'] },
      ],
    });
    const touched: string[] = [];
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: touched });
    const b = ctxGraph.node('B');
    expect(b?.id).toBe('B');
    expect(b?.type).toBe('provider');
    expect(b?.files.find(f => f.path === 'src/b.ts')?.content).toBe('b');
    expect(touched).toContain('src/b.ts');
  });

  it('node() throws for undeclared target', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'A', type: 'm', mapping: [] }, { path: 'C', type: 'm', mapping: [] }],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    expect(() => ctxGraph.node('C')).toThrow(UndeclaredGraphReadError);
  });

  it('node() allows hierarchy (parent always allowed)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'm', mapping: ['src/a.ts'] },
        { path: 'root/child', type: 'm', mapping: ['src/b.ts'], parent: 'root' },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'root/child', graph: g, projectRoot, touchedFiles: [] });
    expect(ctxGraph.node('root')).toBeDefined();
  });

  it('nodesByType filtered to allowed scope only', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'provider', mapping: ['src/b.ts'] },
        { path: 'C', type: 'provider', mapping: ['src/c.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const providers = ctxGraph.nodesByType('provider');
    expect(providers.map(n => n.id)).toEqual(['B']);
  });

  it('children() returns direct child nodes', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'root', type: 'm', mapping: ['src/a.ts'] },
        { path: 'root/x', type: 'm', mapping: ['src/b.ts'], parent: 'root' },
        { path: 'root/y', type: 'm', mapping: ['src/c.ts'], parent: 'root' },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'root', graph: g, projectRoot, touchedFiles: [] });
    const root = ctxGraph.node('root')!;
    const kids = ctxGraph.children(root);
    expect(kids.map(n => n.id).sort()).toEqual(['root/x', 'root/y']);
  });

  it('children() of a relation target descends transitively (dogfood prerequisite)', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'consumer', type: 'm', mapping: ['src/c.ts'],
          relations: [{ type: 'uses', target: 'suite' }] },
        { path: 'suite', type: 'm', mapping: [] },
        { path: 'suite/leaf-a', type: 'm', mapping: ['tests/a.test.ts'], parent: 'suite' },
        { path: 'suite/leaf-b', type: 'm', mapping: ['tests/b.test.ts'], parent: 'suite' },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'consumer', graph: g, projectRoot, touchedFiles: [] });
    const suite = ctxGraph.node('suite')!;
    const kids = ctxGraph.children(suite);
    expect(kids.map(n => n.id).sort()).toEqual(['suite/leaf-a', 'suite/leaf-b']);
    for (const kid of kids) {
      expect(() => ctxGraph.children(kid)).not.toThrow();
    }
  });

  it('relationsFrom() returns declared relations of a node', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'm', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const a = ctxGraph.node('A')!;
    const rels = ctxGraph.relationsFrom(a);
    expect(rels).toHaveLength(1);
    expect(rels[0]?.type).toBe('uses');
    expect(rels[0]?.target).toBe('B');
  });

  it('relationsTo() returns relations pointing at a given node', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'm', mapping: ['src/a.ts'], relations: [{ type: 'calls', target: 'B' }] },
        { path: 'B', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const b = ctxGraph.node('B')!;
    const rels = ctxGraph.relationsTo(b);
    expect(rels).toHaveLength(1);
    expect(rels[0]?.type).toBe('calls');
  });

  it('flowParticipants() returns nodes in the flow when current node participates', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'X', type: 'm', mapping: ['src/a.ts'] },
        { path: 'Y', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    // Manually add a flow with both nodes
    (g.flows as Array<{ path: string; name: string; nodes: string[] }>).push({
      path: 'test-flow', name: 'test-flow', nodes: ['X', 'Y'],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'X', graph: g, projectRoot, touchedFiles: [] });
    const participants = ctxGraph.flowParticipants('test-flow');
    expect(participants.map(n => n.id).sort()).toEqual(['X', 'Y']);
  });

  it('flowParticipants() throws for non-participating flow', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'X', type: 'm', mapping: ['src/a.ts'] },
        { path: 'Y', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    (g.flows as Array<{ path: string; name: string; nodes: string[] }>).push({
      path: 'other-flow', name: 'other-flow', nodes: ['Y'],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'X', graph: g, projectRoot, touchedFiles: [] });
    expect(() => ctxGraph.flowParticipants('other-flow')).toThrow(UndeclaredGraphReadError);
  });

  it('flowParticipants() returns empty array for unknown flow', () => {
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'X', type: 'm', mapping: ['src/a.ts'] }],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'X', graph: g, projectRoot, touchedFiles: [] });
    const result = ctxGraph.flowParticipants('no-such-flow');
    expect(result).toEqual([]);
  });

  it('flowParticipants() matches flow by path when name differs', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'X', type: 'm', mapping: ['src/a.ts'] },
        { path: 'Y', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    // Add flow where name != path; find by path
    (g.flows as Array<{ path: string; name: string; nodes: string[] }>).push({
      path: 'flow-path', name: 'flow-name', nodes: ['X', 'Y'],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'X', graph: g, projectRoot, touchedFiles: [] });
    const participants = ctxGraph.flowParticipants('flow-path');
    expect(participants.map(n => n.id).sort()).toEqual(['X', 'Y']);
  });

  it('flowParticipants() allows child node to access parent-declared flow', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'parent', type: 'm', mapping: ['src/a.ts'] },
        { path: 'parent/child', type: 'm', mapping: ['src/b.ts'], parent: 'parent' },
        { path: 'other', type: 'm', mapping: ['src/c.ts'] },
      ],
    });
    // Flow declares parent node — child should be allowed access
    (g.flows as Array<{ path: string; name: string; nodes: string[] }>).push({
      path: 'parent-flow', name: 'parent-flow', nodes: ['parent', 'other'],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'parent/child', graph: g, projectRoot, touchedFiles: [] });
    const participants = ctxGraph.flowParticipants('parent-flow');
    expect(participants.map(n => n.id).sort()).toEqual(['other', 'parent']);
  });

  it('relationsTo() returns empty array when no relation points to given node', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'm', mapping: ['src/a.ts'] },
        { path: 'B', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const a = ctxGraph.node('A')!;
    expect(ctxGraph.relationsTo(a)).toHaveLength(0);
  });

  it('relationsFrom() returns empty array for node with no relations', () => {
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'm', mapping: ['src/a.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const a = ctxGraph.node('A')!;
    expect(ctxGraph.relationsFrom(a)).toHaveLength(0);
  });

  it('relationsTo() filters out relations pointing to a different node', () => {
    // A -> B; ask relationsTo(A) from A's perspective — B points nowhere,
    // so loop iterates A's relation (target B != A) and returns empty.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'm', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'B' }] },
        { path: 'B', type: 'm', mapping: ['src/b.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    const a = ctxGraph.node('A')!;
    // relationsTo(a) scans allowed nodes for rels where target === 'A'; none exist
    expect(ctxGraph.relationsTo(a)).toHaveLength(0);
  });

  it('children() returns empty array for a leaf node with no children in graph', () => {
    // Exercises the m.children.map path where children array is empty
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'leaf', type: 'm', mapping: ['src/a.ts'] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'leaf', graph: g, projectRoot, touchedFiles: [] });
    const leaf = ctxGraph.node('leaf')!;
    expect(ctxGraph.children(leaf)).toEqual([]);
  });

  it('flowParticipants() skips flow nodes absent from graph.nodes', () => {
    // Flow lists a node id that was never added to graph.nodes — covers the
    // if (m) branch in the result-building loop being false.
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'X', type: 'm', mapping: ['src/a.ts'] }],
    });
    (g.flows as Array<{ path: string; name: string; nodes: string[] }>).push({
      path: 'partial-flow', name: 'partial-flow', nodes: ['X', 'ghost-node'],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'X', graph: g, projectRoot, touchedFiles: [] });
    const participants = ctxGraph.flowParticipants('partial-flow');
    // ghost-node is absent from graph, so only X is returned
    expect(participants.map(n => n.id)).toEqual(['X']);
  });

  it('nodesByType() skips allowed paths absent from graph.nodes', () => {
    // node A has a relation to 'ghost' which is not in graph.nodes.
    // computeAllowedNodePaths adds 'ghost' to allowed; nodesByType must skip it.
    const g = buildTestGraphForStructure({
      nodes: [
        { path: 'A', type: 'consumer', mapping: ['src/a.ts'], relations: [{ type: 'uses', target: 'ghost' }] },
      ],
    });
    const ctxGraph = createCtxGraph({ currentNodePath: 'A', graph: g, projectRoot, touchedFiles: [] });
    // 'ghost' is allowed but not in graph.nodes — nodesByType must not throw
    const consumers = ctxGraph.nodesByType('consumer');
    expect(consumers.map(n => n.id)).toEqual(['A']);
  });
});
