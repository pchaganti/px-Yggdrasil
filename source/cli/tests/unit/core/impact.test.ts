import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDescendants } from '../../../src/cli/impact.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  collectStructureCascade,
} from '../../../src/core/graph/impact-graph.js';
import { computeEffectiveAspects } from '../../../src/core/graph/aspects.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';

function makeNode(nodePath: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: nodePath,
    meta: { name: nodePath.split('/').pop()!, type: 'service' },
    children: [],
    parent: null,
    ...overrides,
  };
}

function makeGraph(nodes: GraphNode[]): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(nodes.map((n) => [n.path, n])),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: '/tmp',
  };
}

describe('collectReverseDependents', () => {
  it('returns empty when no nodes depend on target', () => {
    const target = makeNode('a');
    const graph = makeGraph([target]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
    expect(result.allDependents).toEqual([]);
  });

  it('finds direct dependents via structural relations', () => {
    const target = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const graph = makeGraph([target, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b']);
  });

  it('finds transitive dependents', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toContain('b');
    expect(result.allDependents).toContain('c');
  });

  it('handles diamond dependency without duplication', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [
          { target: 'a', type: 'uses' },
          { target: 'b', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c]);
    const result = collectReverseDependents(graph, 'a');
    expect([...result.direct].sort()).toEqual(['b', 'c']);
    expect(new Set(result.allDependents).size).toBe(result.allDependents.length);
  });

  it('ignores event relations (emits/listens)', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'emits' }],
      },
    });
    const graph = makeGraph([a, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual([]);
  });
});

describe('buildTransitiveChains', () => {
  it('chains do NOT include the target node', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains.length).toBe(1);
    expect(chains[0]).not.toContain('<- a');
    expect(chains[0]).toBe('<- b <- c');
  });

  it('returns empty when no transitive-only deps', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    expect(chains).toEqual([]);
  });
});

describe('collectDescendants', () => {
  it('returns all descendants of a parent node', () => {
    const parent = makeNode('mod');
    const child1 = makeNode('mod/a', { parent });
    const child2 = makeNode('mod/b', { parent });
    const grandchild = makeNode('mod/a/x', { parent: child1 });
    parent.children = [child1, child2];
    child1.children = [grandchild];
    const graph = makeGraph([parent, child1, child2, grandchild]);
    const result = collectDescendants(graph, 'mod');
    expect(result.sort()).toEqual(['mod/a', 'mod/a/x', 'mod/b']);
  });

  it('returns empty for leaf node', () => {
    const leaf = makeNode('leaf');
    const graph = makeGraph([leaf]);
    expect(collectDescendants(graph, 'leaf')).toEqual([]);
  });
});

describe('collectEffectiveAspectIds', () => {
  it('collects own aspects', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['tag-a'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [{ name: 'A', id: 'tag-a', reviewer: { type: 'llm' as const }, artifacts: [] }];
    const result = computeEffectiveAspects(graph.nodes.get('a')!, graph);
    expect([...result]).toEqual(['tag-a']);
  });

  it('collects hierarchy aspects from parent', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['tag-parent'] },
    });
    const child = makeNode('mod/svc', { parent });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'P', id: 'tag-parent', reviewer: { type: 'llm' as const }, artifacts: [] }];
    const result = computeEffectiveAspects(graph.nodes.get('mod/svc')!, graph);
    expect([...result]).toContain('tag-parent');
  });

  it('collects flow aspects', () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    graph.aspects = [{ name: 'Saga', id: 'requires-saga', reviewer: { type: 'llm' as const }, artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['a'],
      aspects: ['requires-saga'],
    }];
    const result = computeEffectiveAspects(graph.nodes.get('a')!, graph);
    expect([...result]).toContain('requires-saga');
  });

  it('expands implies recursively', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['tag-a'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [
      { name: 'A', id: 'tag-a', implies: ['tag-b'], reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'B', id: 'tag-b', reviewer: { type: 'llm' as const }, artifacts: [] },
    ];
    const result = computeEffectiveAspects(graph.nodes.get('a')!, graph);
    expect([...result]).toContain('tag-a');
    expect([...result]).toContain('tag-b');
  });

  it('collects flow aspects via ancestor participation', () => {
    const parent = makeNode('mod');
    const child = makeNode('mod/svc', { parent });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'Saga', id: 'requires-saga', reviewer: { type: 'llm' as const }, artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod'],
      aspects: ['requires-saga'],
    }];
    const result = computeEffectiveAspects(graph.nodes.get('mod/svc')!, graph);
    expect([...result]).toContain('requires-saga');
  });

  it('expands multi-level implies chains', () => {
    const node = makeNode('a', {
      meta: { name: 'a', type: 'service', aspects: ['hipaa'] },
    });
    const graph = makeGraph([node]);
    graph.aspects = [
      { name: 'HIPAA', id: 'hipaa', implies: ['audit'], reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Audit', id: 'audit', implies: ['logging'], reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Logging', id: 'logging', reviewer: { type: 'llm' as const }, artifacts: [] },
    ];
    const result = computeEffectiveAspects(graph.nodes.get('a')!, graph);
    expect([...result]).toContain('hipaa');
    expect([...result]).toContain('audit');
    expect([...result]).toContain('logging');
  });

  it('combines own + hierarchy + flow + implies into effective set', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['parent-aspect'] },
    });
    const child = makeNode('mod/svc', {
      parent,
      meta: { name: 'svc', type: 'service', aspects: ['own-aspect'] },
    });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [
      { name: 'Own', id: 'own-aspect', implies: ['implied-aspect'], reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Parent', id: 'parent-aspect', reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Flow', id: 'flow-aspect', reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Implied', id: 'implied-aspect', reviewer: { type: 'llm' as const }, artifacts: [] },
    ];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod/svc'],
      aspects: ['flow-aspect'],
    }];
    const result = computeEffectiveAspects(graph.nodes.get('mod/svc')!, graph);
    expect([...result]).toContain('own-aspect');
    expect([...result]).toContain('parent-aspect');
    expect([...result]).toContain('flow-aspect');
    expect([...result]).toContain('implied-aspect');
    expect(result.size).toBe(4);
  });

  it('returns empty set for node with no aspects, no hierarchy aspects, no flows', () => {
    const node = makeNode('isolated');
    const graph = makeGraph([node]);
    const result = computeEffectiveAspects(graph.nodes.get('isolated')!, graph);
    expect(result.size).toBe(0);
  });

  it('deduplicates aspects from multiple sources', () => {
    const parent = makeNode('mod', {
      meta: { name: 'mod', type: 'module', aspects: ['shared'] },
    });
    const child = makeNode('mod/svc', {
      parent,
      meta: { name: 'svc', type: 'service', aspects: ['shared'] },
    });
    parent.children = [child];
    const graph = makeGraph([parent, child]);
    graph.aspects = [{ name: 'Shared', id: 'shared', reviewer: { type: 'llm' as const }, artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['mod/svc'],
      aspects: ['shared'],
    }];
    const result = computeEffectiveAspects(graph.nodes.get('mod/svc')!, graph);
    expect([...result]).toEqual(['shared']);
  });
});

describe('co-aspect nodes detection', () => {
  it('finds nodes sharing aspects via effective aspect set', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['audit'] },
    });
    const b = makeNode('svc-b', {
      meta: { name: 'svc-b', type: 'service', aspects: ['audit'] },
    });
    const c = makeNode('svc-c', {
      meta: { name: 'svc-c', type: 'service' },
    });
    const graph = makeGraph([a, b, c]);
    graph.aspects = [{ name: 'Audit', id: 'audit', reviewer: { type: 'llm' as const }, artifacts: [] }];

    const targetEffective = computeEffectiveAspects(graph.nodes.get('svc-a')!, graph);
    const coAspectNodes: Array<{ path: string; shared: string[] }> = [];
    for (const [p] of graph.nodes) {
      if (p === 'svc-a') continue;
      const nodeEffective = computeEffectiveAspects(graph.nodes.get(p)!, graph);
      const shared = [...targetEffective].filter((id) => nodeEffective.has(id));
      if (shared.length > 0) {
        coAspectNodes.push({ path: p, shared });
      }
    }
    expect(coAspectNodes).toHaveLength(1);
    expect(coAspectNodes[0].path).toBe('svc-b');
    expect(coAspectNodes[0].shared).toEqual(['audit']);
  });

  it('detects co-aspect via implies chain', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['hipaa'] },
    });
    const b = makeNode('svc-b', {
      meta: { name: 'svc-b', type: 'service', aspects: ['audit'] },
    });
    const graph = makeGraph([a, b]);
    graph.aspects = [
      { name: 'HIPAA', id: 'hipaa', implies: ['audit'], reviewer: { type: 'llm' as const }, artifacts: [] },
      { name: 'Audit', id: 'audit', reviewer: { type: 'llm' as const }, artifacts: [] },
    ];

    const targetEffective = computeEffectiveAspects(graph.nodes.get('svc-a')!, graph);
    expect(targetEffective.has('audit')).toBe(true);

    const bEffective = computeEffectiveAspects(graph.nodes.get('svc-b')!, graph);
    const shared = [...targetEffective].filter((id) => bEffective.has(id));
    expect(shared).toContain('audit');
  });

  it('detects co-aspect via flow propagation', () => {
    const a = makeNode('svc-a', {
      meta: { name: 'svc-a', type: 'service', aspects: ['logging'] },
    });
    const b = makeNode('svc-b');
    const graph = makeGraph([a, b]);
    graph.aspects = [{ name: 'Logging', id: 'logging', reviewer: { type: 'llm' as const }, artifacts: [] }];
    graph.flows = [{
      name: 'F', path: 'f', nodes: ['svc-b'],
      aspects: ['logging'],
    }];

    const aEffective = computeEffectiveAspects(graph.nodes.get('svc-a')!, graph);
    const bEffective = computeEffectiveAspects(graph.nodes.get('svc-b')!, graph);
    const shared = [...aEffective].filter((id) => bEffective.has(id));
    expect(shared).toContain('logging');
  });
});

describe('collectIndirectDependents', () => {
  it('returns empty when no reverse dependents exist', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a', 'b']);
    expect(result.indirectPaths).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('finds direct reverse dependents of affected nodes', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a']);
    expect(result.indirectPaths).toEqual(['b']);
    expect(result.chains).toEqual(['<- b <- a']);
  });

  it('finds transitive reverse dependents with full chain', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'calls' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    const result = collectIndirectDependents(graph, ['a']);
    expect([...result.indirectPaths].sort()).toEqual(['b', 'c']);
    expect(result.chains).toContain('<- b <- a');
    expect(result.chains).toContain('<- c <- b <- a');
  });

  it('excludes nodes that are in the directly-affected set', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'uses' }],
      },
    });
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [{ target: 'b', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c]);
    // b is directly affected, so only c should appear as indirect
    const result = collectIndirectDependents(graph, ['a', 'b']);
    expect(result.indirectPaths).toEqual(['c']);
    expect(result.chains).toEqual(['<- c <- b']);
  });

  it('keeps shortest chain when reachable from multiple affected nodes', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c', {
      meta: {
        name: 'c',
        type: 'service',
        relations: [
          { target: 'a', type: 'uses' },
          { target: 'b', type: 'uses' },
        ],
      },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [{ target: 'c', type: 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    // Both a and b are directly affected. c uses both → shortest chain is length 2
    // d uses c → shortest chain via either a or b is length 3
    const result = collectIndirectDependents(graph, ['a', 'b']);
    expect([...result.indirectPaths].sort()).toEqual(['c', 'd']);
    // c's chain should be length 2 (one hop from an affected node)
    const cChain = result.chains[result.indirectPaths.indexOf('c')];
    expect(cChain.split(' <- ').length).toBe(2);
  });

  it('follows event relations (emits/listens)', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: {
        name: 'b',
        type: 'service',
        relations: [{ target: 'a', type: 'emits' }],
      },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a']);
    expect(result.indirectPaths).toEqual(['b']);
    expect(result.chains).toEqual(['<- b <- a']);
  });
});

describe('collectStructureCascade', () => {
  function makeStructureAspect(id: string): AspectDef {
    return {
      id,
      name: id,
      reviewer: { type: 'structure' },
      artifacts: [],
    };
  }

  function makeGraphWithAspects(
    nodes: GraphNode[],
    aspects: AspectDef[],
    rootPath: string,
  ): Graph {
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map(nodes.map((n) => [n.path, n])),
      aspects,
      flows: [],
      schemas: [],
      rootPath,
    };
  }

  it('excludes the structural owner from the cascade', async () => {
    const owner = makeNode('owner', {
      meta: {
        name: 'owner',
        type: 'engine',
        aspects: ['shape'],
        mapping: ['src/owner.ts'],
      },
    });
    const graph = makeGraphWithAspects([owner], [makeStructureAspect('shape')], '/tmp');
    const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
    expect(result).toEqual([]);
  });

  it('cold-start: reports a node whose non-draft structure aspect allows reading the file as potential', async () => {
    // The neighbour declares a relation to the owner, so the owner's mapped
    // file is in the neighbour's allowed-reads set (relation-target mapping).
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape'],
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects(
      [owner, neighbour],
      [makeStructureAspect('shape')],
      '/tmp',
    );
    const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'potential' }]);
  });

  it('cold-start: skips a structure-aspect node when the file is outside its allowed reads', async () => {
    // The neighbour has a structure aspect but declares no relation to the
    // owner, so the owner's file is not in the neighbour's allowed-reads set.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape'],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects(
      [owner, neighbour],
      [makeStructureAspect('shape')],
      '/tmp',
    );
    const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
    expect(result).toEqual([]);
  });

  it('cold-start: skips nodes with no effective structure aspect', async () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [], '/tmp');
    const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
    expect(result).toEqual([]);
  });

  it('cold-start: a draft structure aspect does not produce a potential cascade', async () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape'],
        // Explicit per-attach draft status on the own-aspect channel (channel 1).
        aspectStatus: { shape: 'draft' },
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const aspect = makeStructureAspect('shape');
    aspect.status = 'draft';
    const graph = makeGraphWithAspects([owner, neighbour], [aspect], '/tmp');
    const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
    expect(result).toEqual([]);
  });

  it('precise: reports a node whose baseline records the file under structureTouchedFiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'impact-structure-cascade-'));
    try {
      const yggRoot = join(dir, '.yggdrasil');
      await mkdir(yggRoot, { recursive: true });

      const owner = makeNode('owner', {
        meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
      });
      const neighbour = makeNode('neighbour', {
        meta: {
          name: 'neighbour',
          type: 'engine',
          aspects: ['shape'],
          mapping: ['src/neighbour.ts'],
        },
      });
      const graph = makeGraphWithAspects(
        [owner, neighbour],
        [makeStructureAspect('shape')],
        yggRoot,
      );

      // Baseline records that the neighbour's structure aspect read the owner's
      // file cross-node — collectTrackedFiles emits it under 'structure-touched'.
      await writeNodeDriftState(yggRoot, 'neighbour', {
        hash: 'h',
        files: {},
        structureTouchedFiles: {
          shape: { 'src/owner.ts': 'sha-of-owner' },
        },
      });

      const result = await collectStructureCascade(graph, 'src/owner.ts', 'owner');
      expect(result).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);

      // A file the baseline did not touch yields no cascade.
      const none = await collectStructureCascade(graph, 'src/unrelated.ts', 'owner');
      expect(none).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
