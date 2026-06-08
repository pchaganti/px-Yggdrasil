import { describe, it, expect, afterEach } from 'vitest';
import { computeEffectiveAspects } from '../../../src/core/graph/aspects.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';
import type { Graph } from '../../../src/model/graph.js';

// ============================================================================
// Bug-bounty test surface: computeEffectiveAspects — channel 1 (own node
// aspects) and channel 2 (ancestor hierarchy inheritance) ONLY.
//
// To keep the surface isolated to channels 1 & 2 we:
//   - use node types `service` / `module` (buildTestGraph wires these with NO
//     default architecture aspects → channels 3 & 4 stay silent),
//   - declare NO flows (channel 5 silent),
//   - declare NO ports / relations (channel 6 silent),
//   - declare NO `implies` on aspects (channel 7 silent) UNLESS a specific test
//     needs to confirm implies does not leak into a channel-1/2 expectation.
//
// All aspects default to status `enforced` (none draft), so the effective set
// returned by computeEffectiveAspects is exactly the union of own + ancestor
// aspect ids (after dedup). The function returns a Set<string>; we compare
// sorted arrays for stable assertions.
// ============================================================================

afterEach(() => {
  cleanupTestGraphs();
});

/** Effective aspect ids for a node, sorted for stable comparison. */
function eff(graph: Graph, nodePath: string): string[] {
  const node = graph.nodes.get(nodePath);
  if (!node) throw new Error(`test setup: node '${nodePath}' not in graph`);
  return [...computeEffectiveAspects(node, graph)].sort();
}

// ---------------------------------------------------------------------------
// Channel 1 — own node aspects
// ---------------------------------------------------------------------------

describe('channel 1 — own node aspects', () => {
  it('a root node with no aspects has an empty effective set', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'root', type: 'module' }],
    });
    expect(eff(graph, 'root')).toEqual([]);
  });

  it('a root node with an undefined aspects array has an empty effective set', () => {
    // buildTestGraph leaves meta.aspects undefined when aspects is omitted —
    // iterateAttachments uses `?? []`, so this must not throw.
    const graph = buildTestGraph({
      nodes: [{ path: 'root', type: 'service' }],
    });
    const node = graph.nodes.get('root')!;
    expect(node.meta.aspects).toBeUndefined();
    expect(eff(graph, 'root')).toEqual([]);
  });

  it('a root node with an explicit empty aspects array has an empty effective set', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }],
      nodes: [{ path: 'root', type: 'service', aspects: [] }],
    });
    expect(eff(graph, 'root')).toEqual([]);
  });

  it('a single own aspect appears in the effective set', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1'] }],
    });
    expect(eff(graph, 'root')).toEqual(['a1']);
  });

  it('multiple own aspects all appear in the effective set', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1', 'a2', 'a3'] }],
    });
    expect(eff(graph, 'root')).toEqual(['a1', 'a2', 'a3']);
  });

  it('duplicate ids listed twice in the own aspects array collapse to one', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1', 'a1'] }],
    });
    expect(eff(graph, 'root')).toEqual(['a1']);
  });

  it('returns a Set instance (not an array)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1'] }],
    });
    const node = graph.nodes.get('root')!;
    const result = computeEffectiveAspects(node, graph);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(1);
    expect(result.has('a1')).toBe(true);
  });

  it('an own aspect id that is not declared in graph.aspects still surfaces (no existence gate on channel 1)', () => {
    // computeEffectiveAspects does not require the aspect id to exist in
    // graph.aspects to be effective; the attach declaration alone is enough.
    // (The implies-expansion lookup tolerates the missing def.)
    const graph = buildTestGraph({
      aspects: [],
      nodes: [{ path: 'root', type: 'service', aspects: ['ghost'] }],
    });
    expect(eff(graph, 'root')).toEqual(['ghost']);
  });

  it('aspect status on the node does not change the effective id SET (all non-draft)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1', status: 'advisory' }, { id: 'a2', status: 'enforced' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1', 'a2'] }],
    });
    expect(eff(graph, 'root')).toEqual(['a1', 'a2']);
  });
});

// ---------------------------------------------------------------------------
// Channel 2 — single-level ancestor inheritance
// ---------------------------------------------------------------------------

describe('channel 2 — single parent inheritance', () => {
  it('a child inherits its parent aspect', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'p1' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['p1'] },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['p1']);
  });

  it('a child inherits multiple parent aspects', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'p1' }, { id: 'p2' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['p1', 'p2'] },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['p1', 'p2']);
  });

  it('a child combines its own aspects with inherited parent aspects', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'own1' }, { id: 'par1' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['par1'] },
        { path: 'mod/svc', type: 'service', aspects: ['own1'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['own1', 'par1']);
  });

  it('the parent itself does NOT inherit the child aspects (downward-only is wrong; inheritance is upward-reading)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'own1' }, { id: 'child1' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['own1'] },
        { path: 'mod/svc', type: 'service', aspects: ['child1'], parent: 'mod' },
      ],
    });
    // Parent sees only its own aspects, never the child's.
    expect(eff(graph, 'mod')).toEqual(['own1']);
  });

  it('a parent with no aspects contributes nothing to the child', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'own1' }],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', aspects: ['own1'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['own1']);
  });

  it('a child with no own aspects gets exactly its parent aspects', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'p1' }, { id: 'p2' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['p1', 'p2'] },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['p1', 'p2']);
  });
});

// ---------------------------------------------------------------------------
// Dedup across channels 1 & 2 (same aspect from own AND ancestor)
// ---------------------------------------------------------------------------

describe('dedup — same aspect from own + ancestor', () => {
  it('an aspect on both the node and its parent appears exactly once', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'shared' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['shared'] },
        { path: 'mod/svc', type: 'service', aspects: ['shared'], parent: 'mod' },
      ],
    });
    const node = graph.nodes.get('mod/svc')!;
    const result = computeEffectiveAspects(node, graph);
    expect(result.size).toBe(1);
    expect([...result]).toEqual(['shared']);
  });

  it('an aspect repeated across grandparent, parent, and node appears exactly once', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'shared' }],
      nodes: [
        { path: 'a', type: 'module', aspects: ['shared'] },
        { path: 'a/b', type: 'module', aspects: ['shared'], parent: 'a' },
        { path: 'a/b/c', type: 'service', aspects: ['shared'], parent: 'a/b' },
      ],
    });
    const node = graph.nodes.get('a/b/c')!;
    const result = computeEffectiveAspects(node, graph);
    expect(result.size).toBe(1);
    expect([...result]).toEqual(['shared']);
  });

  it('mix of shared and distinct aspects across own + ancestor dedups only the shared one', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'shared' }, { id: 'onlyParent' }, { id: 'onlyChild' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['shared', 'onlyParent'] },
        { path: 'mod/svc', type: 'service', aspects: ['shared', 'onlyChild'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['onlyChild', 'onlyParent', 'shared']);
  });
});

// ---------------------------------------------------------------------------
// Deeply nested chains
// ---------------------------------------------------------------------------

describe('deeply nested ancestor chains', () => {
  it('a 3-level chain accumulates aspects from every ancestor', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      nodes: [
        { path: 'l1', type: 'module', aspects: ['a'] },
        { path: 'l1/l2', type: 'module', aspects: ['b'], parent: 'l1' },
        { path: 'l1/l2/l3', type: 'service', aspects: ['c'], parent: 'l1/l2' },
      ],
    });
    expect(eff(graph, 'l1/l2/l3')).toEqual(['a', 'b', 'c']);
  });

  it('a 5-level chain accumulates one distinct aspect per level', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'l1a' }, { id: 'l2a' }, { id: 'l3a' }, { id: 'l4a' }, { id: 'l5a' }],
      nodes: [
        { path: 'n1', type: 'module', aspects: ['l1a'] },
        { path: 'n1/n2', type: 'module', aspects: ['l2a'], parent: 'n1' },
        { path: 'n1/n2/n3', type: 'module', aspects: ['l3a'], parent: 'n1/n2' },
        { path: 'n1/n2/n3/n4', type: 'module', aspects: ['l4a'], parent: 'n1/n2/n3' },
        { path: 'n1/n2/n3/n4/n5', type: 'service', aspects: ['l5a'], parent: 'n1/n2/n3/n4' },
      ],
    });
    expect(eff(graph, 'n1/n2/n3/n4/n5')).toEqual(['l1a', 'l2a', 'l3a', 'l4a', 'l5a']);
  });

  it('an intermediate node in the chain only inherits from levels above it', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'top' }, { id: 'mid' }, { id: 'bot' }],
      nodes: [
        { path: 'n1', type: 'module', aspects: ['top'] },
        { path: 'n1/n2', type: 'module', aspects: ['mid'], parent: 'n1' },
        { path: 'n1/n2/n3', type: 'service', aspects: ['bot'], parent: 'n1/n2' },
      ],
    });
    // Middle node: own (mid) + grandparent-as-ancestor (top); NOT the leaf (bot).
    expect(eff(graph, 'n1/n2')).toEqual(['mid', 'top']);
  });

  it('a deep chain where only the topmost ancestor has an aspect propagates it to the leaf', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'rootOnly' }],
      nodes: [
        { path: 'n1', type: 'module', aspects: ['rootOnly'] },
        { path: 'n1/n2', type: 'module', parent: 'n1' },
        { path: 'n1/n2/n3', type: 'module', parent: 'n1/n2' },
        { path: 'n1/n2/n3/n4', type: 'service', parent: 'n1/n2/n3' },
      ],
    });
    expect(eff(graph, 'n1/n2/n3/n4')).toEqual(['rootOnly']);
  });

  it('a deep chain where only the leaf has an aspect does not leak it to ancestors', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'leafOnly' }],
      nodes: [
        { path: 'n1', type: 'module' },
        { path: 'n1/n2', type: 'module', parent: 'n1' },
        { path: 'n1/n2/n3', type: 'service', aspects: ['leafOnly'], parent: 'n1/n2' },
      ],
    });
    expect(eff(graph, 'n1/n2/n3')).toEqual(['leafOnly']);
    expect(eff(graph, 'n1/n2')).toEqual([]);
    expect(eff(graph, 'n1')).toEqual([]);
  });

  it('dedup holds along a deep chain where the same aspect recurs at non-adjacent levels', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'recur' }, { id: 'midOnly' }],
      nodes: [
        { path: 'n1', type: 'module', aspects: ['recur'] },
        { path: 'n1/n2', type: 'module', aspects: ['midOnly'], parent: 'n1' },
        { path: 'n1/n2/n3', type: 'module', parent: 'n1/n2' },
        { path: 'n1/n2/n3/n4', type: 'service', aspects: ['recur'], parent: 'n1/n2/n3' },
      ],
    });
    // 'recur' at top ancestor + at leaf own → exactly once.
    expect(eff(graph, 'n1/n2/n3/n4')).toEqual(['midOnly', 'recur']);
  });
});

// ---------------------------------------------------------------------------
// Multiple ancestors contributing distinct aspect sets
// ---------------------------------------------------------------------------

describe('multiple ancestors', () => {
  it('two ancestors each contributing several aspects union together at the leaf', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'gp1' }, { id: 'gp2' }, { id: 'p1' }, { id: 'p2' }],
      nodes: [
        { path: 'gp', type: 'module', aspects: ['gp1', 'gp2'] },
        { path: 'gp/p', type: 'module', aspects: ['p1', 'p2'], parent: 'gp' },
        { path: 'gp/p/leaf', type: 'service', parent: 'gp/p' },
      ],
    });
    expect(eff(graph, 'gp/p/leaf')).toEqual(['gp1', 'gp2', 'p1', 'p2']);
  });

  it('siblings under the same parent both inherit the parent aspect but keep distinct own aspects', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'shared' }, { id: 'sibA' }, { id: 'sibB' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['shared'] },
        { path: 'mod/a', type: 'service', aspects: ['sibA'], parent: 'mod' },
        { path: 'mod/b', type: 'service', aspects: ['sibB'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/a')).toEqual(['shared', 'sibA']);
    expect(eff(graph, 'mod/b')).toEqual(['shared', 'sibB']);
    // A sibling's own aspect must not bleed across to the other sibling.
    expect(eff(graph, 'mod/a')).not.toContain('sibB');
    expect(eff(graph, 'mod/b')).not.toContain('sibA');
  });

  it('a branching tree: two leaves under different parents inherit only their own chain', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'rootA' }, { id: 'left' }, { id: 'right' }, { id: 'leafL' }, { id: 'leafR' }],
      nodes: [
        { path: 'root', type: 'module', aspects: ['rootA'] },
        { path: 'root/L', type: 'module', aspects: ['left'], parent: 'root' },
        { path: 'root/R', type: 'module', aspects: ['right'], parent: 'root' },
        { path: 'root/L/leaf', type: 'service', aspects: ['leafL'], parent: 'root/L' },
        { path: 'root/R/leaf', type: 'service', aspects: ['leafR'], parent: 'root/R' },
      ],
    });
    expect(eff(graph, 'root/L/leaf')).toEqual(['leafL', 'left', 'rootA']);
    expect(eff(graph, 'root/R/leaf')).toEqual(['leafR', 'right', 'rootA']);
    // Cross-branch isolation.
    expect(eff(graph, 'root/L/leaf')).not.toContain('right');
    expect(eff(graph, 'root/R/leaf')).not.toContain('left');
  });
});

// ---------------------------------------------------------------------------
// Empty / degenerate cases
// ---------------------------------------------------------------------------

describe('empty and degenerate cases', () => {
  it('every node in a chain with zero aspects anywhere has an empty effective set', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'n1', type: 'module' },
        { path: 'n1/n2', type: 'module', parent: 'n1' },
        { path: 'n1/n2/n3', type: 'service', parent: 'n1/n2' },
      ],
    });
    expect(eff(graph, 'n1')).toEqual([]);
    expect(eff(graph, 'n1/n2')).toEqual([]);
    expect(eff(graph, 'n1/n2/n3')).toEqual([]);
  });

  it('a parent with an empty aspects array contributes nothing', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'own1' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: [] },
        { path: 'mod/svc', type: 'service', aspects: ['own1'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['own1']);
  });

  it('a graph with declared aspects but none attached to any node yields empty effective sets', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }, { id: 'a2' }],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod')).toEqual([]);
    expect(eff(graph, 'mod/svc')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Root nodes
// ---------------------------------------------------------------------------

describe('root nodes', () => {
  it('a root node (parent === null) has no ancestors — collectAncestors returns []', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a1' }],
      nodes: [{ path: 'root', type: 'service', aspects: ['a1'] }],
    });
    const node = graph.nodes.get('root')!;
    expect(node.parent).toBeNull();
    expect(eff(graph, 'root')).toEqual(['a1']);
  });

  it('multiple independent root nodes do not share aspects', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'r1' }, { id: 'r2' }],
      nodes: [
        { path: 'rootA', type: 'service', aspects: ['r1'] },
        { path: 'rootB', type: 'service', aspects: ['r2'] },
      ],
    });
    expect(eff(graph, 'rootA')).toEqual(['r1']);
    expect(eff(graph, 'rootB')).toEqual(['r2']);
    expect(eff(graph, 'rootA')).not.toContain('r2');
    expect(eff(graph, 'rootB')).not.toContain('r1');
  });

  it('a deep node whose entire chain roots at a top-level node inherits the root aspect', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'rootAspect' }, { id: 'leafAspect' }],
      nodes: [
        { path: 'top', type: 'module', aspects: ['rootAspect'] },
        { path: 'top/mid', type: 'module', parent: 'top' },
        { path: 'top/mid/leaf', type: 'service', aspects: ['leafAspect'], parent: 'top/mid' },
      ],
    });
    expect(eff(graph, 'top/mid/leaf')).toEqual(['leafAspect', 'rootAspect']);
  });
});

// ---------------------------------------------------------------------------
// Cross-checks: own/ancestor aspects are not lost to other channels' silence
// ---------------------------------------------------------------------------

describe('isolation — channels 3-7 stay silent for these graphs', () => {
  it('node types service/module carry no default architecture aspects (channels 3 & 4 silent)', () => {
    // If service/module suddenly carried default aspects, the effective set
    // would include extra ids and these channel-1/2 assertions would break.
    const graph = buildTestGraph({
      aspects: [{ id: 'only' }],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', aspects: ['only'], parent: 'mod' },
      ],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['only']);
    expect(eff(graph, 'mod')).toEqual([]);
  });

  it('no flows and no ports means the effective set equals exactly own ∪ ancestor', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'p' }, { id: 'c' }],
      nodes: [
        { path: 'mod', type: 'module', aspects: ['p'] },
        { path: 'mod/svc', type: 'service', aspects: ['c'], parent: 'mod' },
      ],
      flows: [],
    });
    expect(eff(graph, 'mod/svc')).toEqual(['c', 'p']);
  });
});
