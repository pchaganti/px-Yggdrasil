import { describe, it, expect } from 'vitest';
import { collectDescendants } from '../../../src/cli/impact-handlers.js';
import {
  collectReverseDependents,
  buildTransitiveChains,
  collectIndirectDependents,
  collectStructureCascade,
  nodesWithRefusedVerdict,
  classifyInvalidations,
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

  it('traverses a transitive chain a<-b<-c<-d (BFS pushes unseen nodes; re-converging edge skipped)', () => {
    // a depends-on chain b->a, c->b, d->c, plus a SECOND edge d->b that re-converges
    // on an already-seen node so the `seen.has(next)` continue arm is exercised.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'c', type: 'uses' },
          { target: 'b', type: 'uses' }, // re-converges on b (already seen during BFS)
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const result = collectReverseDependents(graph, 'a');
    expect(result.direct).toEqual(['b']);
    expect(result.allDependents).toEqual(['b', 'c', 'd']);
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

  it('skips an already-visited node in the parent BFS (re-converging edge d->b)', () => {
    // a<-b<-c<-d with an extra edge d->b. The parent BFS reaches b first via c, then
    // the d->b edge revisits b (already visited) → the visited.has(next) continue arm.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'b', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'c', type: 'uses' },
          { target: 'b', type: 'uses' }, // re-converges on b
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const { direct, allDependents, reverse } = collectReverseDependents(graph, 'a');
    const chains = buildTransitiveChains('a', direct, allDependents, reverse);
    // c and d are transitive-only; chains start after the target node.
    expect(chains).toContain('<- b <- c');
    expect(chains.some((c2) => c2.includes('<- d'))).toBe(true);
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

  it('event relations (emits/listens) ARE traversed; a non-structural non-event relation is skipped', () => {
    // collectIndirectDependents keeps structural AND event relations. Feed:
    //  - b -emits-> a   (event: traversed)
    //  - c -listens-> a (event: traversed)
    //  - x -bogus-> a   (neither structural nor emits/listens: the continue arm)
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'emits' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'listens' }] },
    });
    const x = makeNode('x', {
      meta: {
        name: 'x',
        type: 'service',
        // intentionally invalid relation type to drive the skip arm (graph data could
        // be hand-edited; the algorithm must defensively ignore unknown relation types).
        relations: [{ target: 'a', type: 'bogus' as unknown as 'uses' }],
      },
    });
    const graph = makeGraph([a, b, c, x]);
    const result = collectIndirectDependents(graph, ['a']);
    // b and c reach a via event relations → indirect; x's bogus relation is ignored.
    expect(result.indirectPaths).toEqual(['b', 'c']);
    expect(result.indirectPaths).not.toContain('x');
  });

  it('keeps the SHORTEST chain when a node is reachable via two affected nodes (diamond)', () => {
    // d depends on both b and c; b and c both depend on a. Mark BOTH a and b as
    // affected. From a, the chain to d is a<-b<-d (depth 3). From b, the chain to d
    // is b<-d (depth 2). The shorter (b<-d) must win — exercising the
    // `depth < existing.depth` replacement arm. The longer candidate hitting an
    // existing-shorter entry exercises its else.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'b', type: 'uses' },
          { target: 'c', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    // a and b are both directly affected; c and d are indirect.
    const result = collectIndirectDependents(graph, ['a', 'b']);
    // d is indirect; its kept chain must be the shorter "b<-d" form (depth 2),
    // not the longer "a<-b<-d" (depth 3).
    expect(result.indirectPaths).toContain('d');
    const dChain = result.chains[result.indirectPaths.indexOf('d')];
    expect(dChain).toBe('<- d <- b');
    // c is reached only from a (one hop).
    expect(result.indirectPaths).toContain('c');
  });

  it('does NOT replace an existing shorter chain when a longer one is found later', () => {
    // Same diamond, but affected order ['b','a'] makes the SHORT chain (from b) be
    // recorded FIRST; processing a afterwards finds a LONGER chain to d, and
    // `depth < existing.depth` is FALSE → the existing shorter chain is kept (else arm).
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const c = makeNode('c', {
      meta: { name: 'c', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const d = makeNode('d', {
      meta: {
        name: 'd',
        type: 'service',
        relations: [
          { target: 'b', type: 'uses' },
          { target: 'c', type: 'uses' },
        ],
      },
    });
    const graph = makeGraph([a, b, c, d]);
    const result = collectIndirectDependents(graph, ['b', 'a']); // b first → short chain recorded first
    expect(result.indirectPaths).toContain('d');
    // The shorter chain (from b: depth 2) must be retained.
    const dChain = result.chains[result.indirectPaths.indexOf('d')];
    expect(dChain).toBe('<- d <- b');
  });

  it('skips a directly-affected node when it is reachable from another affected node', () => {
    // b is directly affected AND reachable from affected a. The BFS from a reaches b,
    // but since b is in directSet it must be skipped as an INDIRECT result.
    const a = makeNode('a');
    const b = makeNode('b', {
      meta: { name: 'b', type: 'service', relations: [{ target: 'a', type: 'uses' }] },
    });
    const graph = makeGraph([a, b]);
    const result = collectIndirectDependents(graph, ['a', 'b']);
    // b is directly affected → never reported as indirect.
    expect(result.indirectPaths).not.toContain('b');
    expect(result.indirectPaths).toEqual([]);
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
    // A second node with NO mapping is present — the owner resolver must tolerate it
    // (mapping defaults to []) and still resolve through the mapped node.
    const mappingless = makeNode('organizational', {
      meta: { name: 'organizational', type: 'service' },
    });
    const graph = makeGraph([mappingless, owner]);
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

  it('ignores a refused unit key with an unrecognized prefix (neither node: nor file:)', () => {
    // A unit key that is neither node:<path> nor file:<path> falls through both
    // branches and is skipped (the else arm of the file: check).
    const graph = makeGraph([makeNode('a')]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'weird:something': entry('refused') } },
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
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'potential', reviewerKind: 'deterministic' }]);
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
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'precise', reviewerKind: 'deterministic' }]);

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
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'precise', reviewerKind: 'deterministic' }]);
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
    expect(collectStructureCascade(graph, 'src/probe.ts', 'owner', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise', reviewerKind: 'deterministic' }]);
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
    expect(collectStructureCascade(graph, ygNode, 'something-else', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise', reviewerKind: 'deterministic' }]);
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
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([{ nodePath: 'neighbour', mode: 'precise', reviewerKind: 'deterministic' }]);
  });

  it('an entry whose touched is EMPTY: the node has a lock entry but it touched nothing → not affected (cold-start suppressed)', () => {
    // hasAnyObservingEntry is true (an observing entry exists) but touched is empty, so precise
    // stays false AND the cold-start allowed-reads probe is suppressed → no cascade.
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape'],
        // declares a relation to owner so the file WOULD be in allowed-reads if probed
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'node:neighbour': { verdict: 'approved', hash: 'h', touched: [] } } },
      nodes: {},
    };
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([]);
  });

  it('a touched key with no colon, an unknown kind, and a non-matching list:/graph: do NOT mark precise', () => {
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
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
            touched: [
              ['noColonHere', 'sha'], // sep < 0 → skipped
              ['weirdkind:src/owner.ts', 'sha'], // unknown kind → switch default
              ['list:src/other', 'sha'], // dir mismatch (file is in src/, not src/other) → no match
              ['graph:somethingelse', 'sha'], // not owner's yg-node.yaml → no match
            ],
          },
        },
      },
      nodes: {},
    };
    // None of the observation keys reference src/owner.ts → not precise; the node has a
    // det entry so cold-start is suppressed → empty cascade.
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([]);
  });

  it('sorts a multi-node cascade by node path (three precise neighbours, both < and > comparisons)', () => {
    // Three neighbours all record a cross-node read of the owner's file → all precise.
    // Inserting them out of order (zeta, alpha, mid) forces the sort comparator to run
    // comparisons in BOTH directions (a<b and a>b), exercising both ternary arms.
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const zeta = makeNode('zeta', {
      meta: { name: 'zeta', type: 'engine', aspects: ['shape'], mapping: ['src/zeta.ts'] },
    });
    const alpha = makeNode('alpha', {
      meta: { name: 'alpha', type: 'engine', aspects: ['shape'], mapping: ['src/alpha.ts'] },
    });
    const mid = makeNode('mid', {
      meta: { name: 'mid', type: 'engine', aspects: ['shape'], mapping: ['src/mid.ts'] },
    });
    // Unsorted accumulation order [zeta, alpha, mid]; sorted result [alpha, mid, zeta].
    const graph = makeGraphWithAspects([owner, zeta, alpha, mid], [makeStructureAspect('shape')]);
    const touched: [string, string][] = [['read:src/owner.ts', 'sha']];
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:zeta': { verdict: 'approved', hash: 'h', touched },
          'node:alpha': { verdict: 'approved', hash: 'h', touched },
          'node:mid': { verdict: 'approved', hash: 'h', touched },
        },
      },
      nodes: {},
    };
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', lock);
    expect(result).toEqual([
      { nodePath: 'alpha', mode: 'precise', reviewerKind: 'deterministic' },
      { nodePath: 'mid', mode: 'precise', reviewerKind: 'deterministic' },
      { nodePath: 'zeta', mode: 'precise', reviewerKind: 'deterministic' },
    ]);
  });

  it('a file: unit key on a node with NO mapping does not belong to it (nullish mapping default)', () => {
    // The neighbour has a deterministic aspect but no mapping. A file:<path> unit key
    // cannot belong to a node with no mapping → unitKeyBelongsToNode returns false,
    // so the entry is skipped and the node has no det entry of its own.
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'] }, // no mapping
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'file:src/somefile.ts': {
            verdict: 'approved',
            hash: 'h',
            touched: [['read:src/owner.ts', 'sha']],
          },
        },
      },
      nodes: {},
    };
    // The file: key does not map to the (mapping-less) neighbour → not precise, and
    // with no det entry of its own the cold-start probe finds no allowed read.
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([]);
  });

  it('a lock entry whose unit key belongs to a DIFFERENT node is ignored for this node', () => {
    // The lock holds an entry under unit key node:elsewhere, plus one under an
    // unrecognized prefix. Neither belongs to `neighbour`, so they do not make it
    // precise; with no entry of its own, the cold-start probe (no relation/allowed
    // read of the file) yields nothing.
    const owner = makeNode('owner', { meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] } });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['shape'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeStructureAspect('shape')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        shape: {
          'node:elsewhere': { verdict: 'approved', hash: 'h', touched: [['read:src/owner.ts', 'sha']] },
          'weird:prefix': { verdict: 'approved', hash: 'h', touched: [['read:src/owner.ts', 'sha']] },
        },
      },
      nodes: {},
    };
    // Entries do not belong to `neighbour` (unitKeyBelongsToNode → false), so it has
    // no det entry of its own → cold-start probe runs but file is not in its reads.
    expect(collectStructureCascade(graph, 'src/owner.ts', 'owner', lock)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Task 9 — companion-LLM aspect in the structure cascade + new touched kinds
// ────────────────────────────────────────────────────────────────────────────

describe('collectStructureCascade — companion-LLM aspect inclusion (Task 9)', () => {
  /** Companion LLM aspect (hasCompanion === true, reviewer.type === 'llm') */
  function makeCompanionLlmAspect(id: string): AspectDef {
    return {
      id,
      name: id,
      reviewer: { type: 'llm' },
      artifacts: [],
      hasCompanion: true,
    };
  }

  /** Plain LLM aspect (no companion) */
  function makePlainLlmAspect(id: string): AspectDef {
    return {
      id,
      name: id,
      reviewer: { type: 'llm' },
      artifacts: [],
    };
  }

  function makeGraphWithAspects(nodes: GraphNode[], aspects: AspectDef[]): Graph {
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map(nodes.map((n) => [n.path, n])),
      aspects,
      flows: [],
      rootPath: '/tmp',
    };
  }

  it('(a) companion-LLM aspect: a lock entry with touched read:<src> is reported when that file is edited', () => {
    // A companion-LLM aspect records `read:src/spec.ts` in its touched array.
    // Editing src/spec.ts must surface the node in the structure cascade with reviewerKind === 'llm'.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['companion-check'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeCompanionLlmAspect('companion-check')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        'companion-check': {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['read:src/spec.ts', 'sha-of-spec']],
          },
        },
      },
      nodes: {},
    };
    const result = collectStructureCascade(graph, 'src/spec.ts', 'owner', lock);
    expect(result).toHaveLength(1);
    expect(result[0].nodePath).toBe('neighbour');
    expect(result[0].mode).toBe('precise');
    expect((result[0] as { reviewerKind: string }).reviewerKind).toBe('llm');
  });

  it('(b) REGRESSION GUARD: plain LLM aspect (no companion) with the same touched is STILL excluded', () => {
    // A plain LLM aspect (hasCompanion === false / undefined) must NOT be included
    // in the structure cascade even if it has touched keys — it has no companion.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['plain-llm'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makePlainLlmAspect('plain-llm')]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        'plain-llm': {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['read:src/spec.ts', 'sha-of-spec']],
          },
        },
      },
      nodes: {},
    };
    // Plain LLM aspect → MUST NOT appear in structure cascade.
    const result = collectStructureCascade(graph, 'src/spec.ts', 'owner', lock);
    expect(result).toEqual([]);
  });

  it('(c1) graph-children: touched key matches the parent node yg-node.yaml', () => {
    // graph-children:owner → references .yggdrasil/model/owner/yg-node.yaml
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['det-check'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [{
      id: 'det-check',
      name: 'det-check',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    }]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        'det-check': {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['graph-children:owner', 'sha-of-children']],
          },
        },
      },
      nodes: {},
    };
    // Editing .yggdrasil/model/owner/yg-node.yaml should match graph-children:owner
    const ygNodeFile = '.yggdrasil/model/owner/yg-node.yaml';
    const result = collectStructureCascade(graph, ygNodeFile, null, lock);
    expect(result).toHaveLength(1);
    expect(result[0].nodePath).toBe('neighbour');
    expect(result[0].mode).toBe('precise');

    // A different yg-node.yaml must NOT match graph-children:owner
    const otherFile = '.yggdrasil/model/other/yg-node.yaml';
    const none = collectStructureCascade(graph, otherFile, null, lock);
    expect(none).toEqual([]);
  });

  it('(c2) graph-flow: touched key matches the flow yg-flow.yaml', () => {
    // graph-flow:checkout → references .yggdrasil/flows/checkout/yg-flow.yaml
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['det-check'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [{
      id: 'det-check',
      name: 'det-check',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    }]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        'det-check': {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['graph-flow:checkout', 'sha-of-flow']],
          },
        },
      },
      nodes: {},
    };
    // Editing .yggdrasil/flows/checkout/yg-flow.yaml should match graph-flow:checkout
    const flowFile = '.yggdrasil/flows/checkout/yg-flow.yaml';
    const result = collectStructureCascade(graph, flowFile, null, lock);
    expect(result).toHaveLength(1);
    expect(result[0].nodePath).toBe('neighbour');
    expect(result[0].mode).toBe('precise');

    // A different flow file must NOT match graph-flow:checkout
    const otherFlow = '.yggdrasil/flows/other-flow/yg-flow.yaml';
    const none = collectStructureCascade(graph, otherFlow, null, lock);
    expect(none).toEqual([]);
  });

  it('deterministic aspect carries reviewerKind: deterministic in result', () => {
    // Existing deterministic aspect path now also returns reviewerKind tag.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: { name: 'neighbour', type: 'engine', aspects: ['det-check'], mapping: ['src/neighbour.ts'] },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [{
      id: 'det-check',
      name: 'det-check',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    }]);
    const lock: LockFile = {
      version: 1,
      verdicts: {
        'det-check': {
          'node:neighbour': {
            verdict: 'approved',
            hash: 'h',
            touched: [['read:src/owner.ts', 'sha']],
          },
        },
      },
      nodes: {},
    };
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', lock);
    expect(result).toHaveLength(1);
    expect((result[0] as { reviewerKind: string }).reviewerKind).toBe('deterministic');
  });

  // ── Finding 1 — cold-start must not fire for companion-LLM-ONLY nodes ──────

  it('(d) cold-start EXCLUSION: a companion-LLM-only node with no lock entries is NOT reported even when the file is in its allowed-reads', () => {
    // The neighbour declares a relation to owner (so owner's file IS in its
    // allowed-reads). But its ONLY observing aspect is a companion-LLM aspect —
    // no deterministic aspect. Cold-start applies only to deterministic aspects
    // (they have an allowed-reads model; companion-LLM aspects do not).
    // → The node must NOT appear in the cascade.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['companion-check'],
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const graph = makeGraphWithAspects([owner, neighbour], [makeCompanionLlmAspect('companion-check')]);
    // No lock entries at all for this node — cold-start would fire IF the node
    // had a deterministic aspect; it must NOT fire for companion-LLM-only.
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([]);
  });

  it('(e) cold-start REGRESSION: a node WITH a deterministic aspect (alongside a companion-LLM) still gets cold-start potential', () => {
    // The neighbour has BOTH a deterministic aspect (shape) and a companion-LLM
    // aspect. With no lock entries, the cold-start fallback MUST still run
    // because a deterministic aspect is present — the node must be reported.
    const owner = makeNode('owner', {
      meta: { name: 'owner', type: 'engine', mapping: ['src/owner.ts'] },
    });
    const neighbour = makeNode('neighbour', {
      meta: {
        name: 'neighbour',
        type: 'engine',
        aspects: ['shape', 'companion-check'],
        relations: [{ target: 'owner', type: 'uses' }],
        mapping: ['src/neighbour.ts'],
      },
    });
    const detAspect: AspectDef = {
      id: 'shape',
      name: 'shape',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    };
    const graph = makeGraphWithAspects([owner, neighbour], [detAspect, makeCompanionLlmAspect('companion-check')]);
    // No lock entries → cold-start fires (deterministic aspect is present).
    const result = collectStructureCascade(graph, 'src/owner.ts', 'owner', emptyLock());
    expect(result).toEqual([{ nodePath: 'neighbour', mode: 'potential', reviewerKind: 'deterministic' }]);
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

  it('keeps the longest match even when the longer mapping is encountered FIRST (shorter loses)', () => {
    // Insertion order puts the LONGER mapping (src/c/**) first, then the SHORTER
    // (src/**). BOTH globs match src/c/x.ts. When the second (shorter) mapping is
    // checked, best already holds the longer one and `m.length > best.len` is FALSE —
    // the shorter must NOT replace it.
    const child = makeNode('p/c', { meta: { name: 'c', type: 'service', mapping: ['src/c/**'] } });
    const parent = makeNode('p', { meta: { name: 'p', type: 'service', mapping: ['src/**'] } });
    const graph = makeGraph([child, parent]); // child (longer mapping) inserted first
    const lock: LockFile = {
      version: 1,
      verdicts: { shape: { 'file:src/c/x.ts': { verdict: 'refused', hash: 'h' } } },
      nodes: {},
    };
    expect([...nodesWithRefusedVerdict(graph, lock, 'shape')]).toEqual(['p/c']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Task 1 — synchronous invalidation buckets (classifyInvalidations)
// ────────────────────────────────────────────────────────────────────────────

describe('classifyInvalidations (sync buckets)', () => {
  /**
   * Returns a graph with node 'n' (mapping src/n/**) carrying three aspects:
   *   - 'd' : deterministic
   *   - 'c' : companion-LLM (hasCompanion: true)
   *   - 'p' : plain-LLM with references: [{path: 'src/n/a.ts'}]
   *
   * 'src/n/a.ts' is within node 'n' allowed-reads (it matches the mapping).
   */
  function makeGraphWithAspects(): Graph {
    const nodeN = makeNode('n', {
      meta: {
        name: 'n',
        type: 'service',
        aspects: ['d', 'c', 'p'],
        mapping: ['src/n'],
      },
    });
    const detAspect: AspectDef = {
      id: 'd',
      name: 'd',
      reviewer: { type: 'deterministic' },
      artifacts: [],
    };
    const companionAspect: AspectDef = {
      id: 'c',
      name: 'c',
      reviewer: { type: 'llm' },
      artifacts: [],
      hasCompanion: true,
    };
    const plainLlmAspect: AspectDef = {
      id: 'p',
      name: 'p',
      reviewer: { type: 'llm' },
      artifacts: [],
      references: [{ path: 'src/n/a.ts' }],
    };
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map([['n', nodeN]]),
      aspects: [detAspect, companionAspect, plainLlmAspect],
      flows: [],
      rootPath: '/tmp',
    };
  }

  it('admits via subject, reference, warm-observation; defers cold companion-LLM', () => {
    const graph = makeGraphWithAspects(); // det aspect 'd' on node 'n', companion-LLM 'c' on 'n', plain-LLM 'p' on 'n'
    const F = 'src/n/a.ts';
    const pairs = [
      { aspectId: 'd', kind: 'deterministic', unitKey: 'file:src/n/a.ts', nodePath: 'n', subjectFiles: ['src/n/a.ts'] },
      { aspectId: 'p', kind: 'llm', unitKey: 'node:n', nodePath: 'n', subjectFiles: ['src/n/b.ts'] }, // references F
      { aspectId: 'c', kind: 'llm', unitKey: 'file:src/n/x.md', nodePath: 'n', subjectFiles: ['src/n/x.md'] }, // cold companion, F in allowed-reads
    ] as any;
    // ensure: aspect 'p' declares references:[{path:'src/n/a.ts'}]; lock empty (all cold); F in node 'n' allowed-reads.
    const lock = { version: 1, verdicts: {}, nodes: {} } as any;
    const { pairs: admitted, coldCompanionCandidates } = classifyInvalidations(pairs, graph, F, lock);
    expect(admitted.find(x => x.aspectId === 'd')?.reasons).toEqual(['own']);
    expect(admitted.find(x => x.aspectId === 'p')?.reasons).toContain('reference');
    expect(coldCompanionCandidates.map(x => x.aspectId)).toEqual(['c']);
    expect(admitted.find(x => x.aspectId === 'c')).toBeUndefined();
  });

  it('warm deterministic observation referencing F => observe-deterministic, precise', () => {
    const graph = makeGraphWithAspects();
    const F = 'src/other/probe.ts';
    const pairs = [{ aspectId: 'd', kind: 'deterministic', unitKey: 'node:n', nodePath: 'n', subjectFiles: ['src/n/a.ts'] }] as any;
    const lock = { version: 1, verdicts: { d: { 'node:n': { verdict: 'approved', touched: [['read:src/other/probe.ts', 'h']] } } }, nodes: {} } as any;
    const { pairs: admitted } = classifyInvalidations(pairs, graph, F, lock);
    expect(admitted[0].reasons).toEqual(['observe-deterministic']);
    expect(admitted[0].mode).toBe('precise');
  });
});
