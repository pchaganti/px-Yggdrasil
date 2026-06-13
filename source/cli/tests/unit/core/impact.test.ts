import { describe, it, expect } from 'vitest';
import { collectDescendants } from '../../../src/cli/impact.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  collectStructureCascade,
  nodesWithRefusedVerdict,
} from '../../../src/core/graph/impact-graph.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import type { LockFile, VerdictEntry } from '../../../src/model/lock.js';

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

function emptyLock(): LockFile {
  return { version: 1, verdicts: {}, nodes: {} };
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
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([target, b]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b']);
  });

  it('ignores event relations for structural reverse dependents', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'emits' }] },
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
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
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
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
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

describe('collectIndirectDependents', () => {
  it('returns empty when no reverse dependents exist', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a', 'b']);
    expect(result.indirectPaths).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('finds reverse dependents of affected nodes', () => {
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a']);
    expect(result.indirectPaths).toEqual(['b']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lock-seeded: refused-verdict annotation (spec §8)
// ────────────────────────────────────────────────────────────────────────────

describe('nodesWithRefusedVerdict (lock-seeded)', () => {
  function entry(verdict: 'approved' | 'refused', touched?: VerdictEntry['touched']): VerdictEntry {
    return { verdict, hash: 'h', ...(touched ? { touched } : {}) };
  }

  it('returns empty when the aspect has no verdicts in the lock', () => {
    const graph = makeGraph([makeNode('a')]);
    expect(nodesWithRefusedVerdict(graph, emptyLock(), 'missing-aspect').size).toBe(0);
  });

  it('maps a node:<path> refused entry directly to that node', () => {
    const graph = makeGraph([makeNode('billing/cancel')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:billing/cancel': entry('refused'),
          'node:billing/other': entry('approved'),
        },
      },
      nodes: {},
    };
    const result = nodesWithRefusedVerdict(graph, lock, 'shape');
    expect([...result]).toEqual(['billing/cancel']);
  });

  it('resolves a file:<path> refused entry to its owning node through the mapping', () => {
    const owner = makeNode('billing', {
      meta: { name: 'billing', type: 'service', mapping: ['src/billing/x.ts'] },
    });
    const graph = makeGraph([owner]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/billing/x.ts': entry('refused') } },
      nodes: {},
    };
    const result = nodesWithRefusedVerdict(graph, lock, 'shape');
    expect([...result]).toEqual(['billing']);
  });

  it('skips a file:<path> entry that maps to no node (stale lock line)', () => {
    const graph = makeGraph([makeNode('a', { meta: { name: 'a', type: 'service', mapping: ['src/a.ts'] } })]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/gone.ts': entry('refused') } },
      nodes: {},
    };
    expect(nodesWithRefusedVerdict(graph, lock, 'shape').size).toBe(0);
  });

  it('ignores approved entries — only refused verdicts annotate', () => {
    const graph = makeGraph([makeNode('a')]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'node:a': entry('approved') } },
      nodes: {},
    };
    expect(nodesWithRefusedVerdict(graph, lock, 'shape').size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Lock-seeded: structure cascade (precise touched-key + cold-start) (spec §8)
// ────────────────────────────────────────────────────────────────────────────

describe('collectStructureCascade (lock-seeded)', () => {
  function makeStructureAspect(id: string, status?: 'draft'): AspectDef {
    return {
      id,
      name: id,
      reviewer: { type: 'deterministic' },
      artifacts: [],
      ...(status ? { status } : {}),
    };
  }

  function makeGraphWithAspects(nodes: GraphNode[], aspects: AspectDef[]): Graph {
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map(nodes.map((n) => [n.path, n])),
      aspects,
      flows: [],
      schemas: [],
      rootPath: '/tmp',
    };
  }

  it('excludes the structural owner from the cascade', () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', aspects: ['shape'], mapping: ['src/owner.ts'] },
    });
    const graph = makeGraphWithAspects([owner], [makeStructureAspect('shape')]);
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([]);
  });

  it('cold-start: reports a node whose non-draft structure aspect MAY read the file as potential', () => {
    // The neighbour declares a relation to the owner, so the owner's mapped file
    // is in the neighbour's allowed-reads set (relation-target mapping). No lock
    // entries exist for the neighbour yet → potential mode.
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
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'potential' }]);
  });

  it('cold-start: skips a structure-aspect node when the file is outside its allowed reads', () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([]);
  });

  it('cold-start: skips nodes with no effective structure aspect', () => {
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
    const graph = makeGraphWithAspects([owner, neighbour], []);
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([]);
  });

  it('cold-start: a draft structure aspect does not produce a potential cascade', () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape'],
        aspectStatus: { shape: 'draft' },
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape', 'draft')]);
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([]);
  });

  it('precise: reports a node whose lock entry records the file under touched (read:)', () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    // The neighbour's deterministic verdict recorded a cross-node read of the
    // owner's file under touched — editing it invalidates the verdict (precise).
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['read:src/owner.ts', 'sha-of-owner']],
          },
        },
      },
      nodes: {},
    };
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', lock);
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);

    // A file the entry did NOT touch yields no cascade for this node (it has a
    // lock entry, so the cold-start fallback is suppressed).
    const none = collectStructureCascade(graph, 'src/unrelated.ts', 'owner', lock);
    expect(none).toEqual([]);
  });

  it('precise: a list: observation invalidates when the edited file lives in that directory', () => {
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/billing/new.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['list:src/billing', 'sha-of-listing']],
          },
        },
      },
      nodes: {},
    };
    // Adding/renaming a file inside src/billing changes the listing hash.
    const result = collectStructureCascade(graph, 'src/billing/new.ts', 'owner', lock);
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);
  });

  it('precise: an exists: observation invalidates when the probed file is edited', () => {
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: { 'node:neighbour': { verdict: 'approved', hash: 'h', touched: [['exists:src/probe.ts', 'sha']] } },
      },
      nodes: {},
    };
    expect(collectStructureCascade(graph, 'src/probe.ts', 'owner', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);
    // A different file is not the probed path → no cascade.
    expect(collectStructureCascade(graph, 'src/other.ts', 'owner', lock)).toEqual([]);
  });

  it('precise: a graph: observation invalidates when the related node yg-node.yaml is edited', () => {
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: { 'node:neighbour': { verdict: 'approved', hash: 'h', touched: [['graph:owner', 'sha']] } },
      },
      nodes: {},
    };
    // graph:owner folds owner's yg-node.yaml bytes — editing that file invalidates.
    const ygNode = '.yggdrasil/model/owner/yg-node.yaml';
    expect(collectStructureCascade(graph, ygNode, 'something-else', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);
  });

  it('precise: a per-file unit key (file:<mapped>) belongs to its owning node', () => {
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/n.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        // per-file scope: the unit key is file:<mapped file of neighbour>.
        shape: { 'file:src/n.ts': { verdict: 'approved', hash: 'h', touched: [['read:src/owner.ts', 'sha']] } },
      },
      nodes: {},
    };
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise' }]);
  });
});

describe('nodesWithRefusedVerdict — longest-mapping owner resolution', () => {
  it('resolves a file to the node with the LONGEST matching mapping (child wins)', () => {
    const parent = makeNode('p', { meta: { name: 'p', type: 'service', mapping: ['src'] } });
    const child = makeNode('p/c', { meta: { name: 'c', type: 'service', mapping: ['src/c'] } });
    const graph = makeGraph([parent, child]);
    const lock: LockFile = {
      version: 1,
      // The file src/c/x.ts is in BOTH mappings (src and src/c); the longer wins.
      verdicts: { shape: { 'file:src/c/x.ts': { verdict: 'refused', hash: 'h' } } },
      nodes: {},
    };
    expect([...nodesWithRefusedVerdict(graph, lock, 'shape')]).toEqual(['p/c']);
  });
});
