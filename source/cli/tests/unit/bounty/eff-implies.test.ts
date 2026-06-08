import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
  hasNonDraftEffectiveAspects,
  isAggregateAspect,
  ImpliesCycleError,
} from '../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ============================================================================
// BOUNTY: effective aspects channel 7 — implies + aggregate.
//
// Surface under test: recursive implies expansion (A->B->C), dedup over the
// implies DAG (diamonds), aggregate aspects (reviewer.type === 'aggregate')
// expanding their implied children while carrying no own verdict, and cycle
// detection (ImpliesCycleError) instead of an infinite loop.
//
// These tests build small in-memory graphs directly (matching the style of
// tests/unit/core/graph/aspect-status.test.ts and the cascade
// characterization test). No filesystem is touched — every graph is a pure
// in-memory object — so no tmpdirs are created.
// ============================================================================

// ---------------------------------------------------------------------------
// Local builders (mirror aspect-status.test.ts style).
// ---------------------------------------------------------------------------

function makeAspect(
  id: string,
  status: 'draft' | 'advisory' | 'enforced' = 'enforced',
  extra: Partial<AspectDef> = {},
): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
    ...extra,
  } as AspectDef;
}

/** Aggregate aspect: reviewer.type 'aggregate', ships no content.md / check.mjs. */
function makeAggregate(id: string, implies: string[], extra: Partial<AspectDef> = {}): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type: 'aggregate' },
    artifacts: [],
    implies,
    ...extra,
  } as AspectDef;
}

function makeNode(
  path: string,
  type: string,
  aspects: string[] = [],
  aspectStatus?: Record<string, 'draft' | 'advisory' | 'enforced'>,
): GraphNode {
  return {
    path,
    meta: { name: path, type, aspects, aspectStatus },
    children: [],
    parent: null,
  } as GraphNode;
}

function makeGraph(aspects: AspectDef[], nodes: GraphNode[] = []): Graph {
  return {
    aspects,
    nodes: new Map(nodes.map((n) => [n.path, n])),
    flows: [],
    architecture: null,
  } as unknown as Graph;
}

/** A `when` predicate that is false for a node of type 'service'. */
const FALSE_FOR_SERVICE: WhenPredicate = { node: { type: 'nonexistent-type' } } as WhenPredicate;
/** A `when` predicate that is true for a node of type 'service'. */
const TRUE_FOR_SERVICE: WhenPredicate = { node: { type: 'service' } } as WhenPredicate;

function effectiveIds(node: GraphNode, graph: Graph): string[] {
  return [...computeEffectiveAspects(node, graph)].sort();
}

// ===========================================================================
// 1. Recursive implies: A -> B -> C
// ===========================================================================

describe('channel 7 — recursive implies (A->B->C)', () => {
  it('expands a 3-level chain fully', () => {
    const graph = makeGraph(
      [
        makeAspect('a', 'enforced', { implies: ['b'] }),
        makeAspect('b', 'enforced', { implies: ['c'] }),
        makeAspect('c', 'enforced'),
      ],
      [],
    );
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b', 'c']);
  });

  it('expands a 4-level chain A->B->C->D', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'] }),
      makeAspect('c', 'enforced', { implies: ['d'] }),
      makeAspect('d', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not pull in aspects that are not reachable from the direct set', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
      makeAspect('orphan', 'enforced', { implies: ['lonely'] }),
      makeAspect('lonely', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
  });

  it('multiple direct roots each expand their own chains', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
      makeAspect('x', 'enforced', { implies: ['y'] }),
      makeAspect('y', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a', 'x']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('implied aspect with no own def is still added (string-level expansion)', () => {
    // 'b' is implied but absent from graph.aspects. Expansion is over ids.
    const graph = makeGraph([makeAspect('a', 'enforced', { implies: ['b'] })]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
  });

  it('status propagation runs the full chain (strictest): A enforced -> B advisory -> C draft', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'advisory', { implies: ['c'] }),
      makeAspect('c', 'draft'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('enforced');
    expect(statuses.get('c')).toBe('enforced');
  });
});

// ===========================================================================
// 2. Dedup: diamonds and shared subtrees visited once
// ===========================================================================

describe('channel 7 — dedup over the implies DAG', () => {
  it('diamond A->B, A->C, B->D, C->D yields each id once', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b', 'c'] }),
      makeAspect('b', 'enforced', { implies: ['d'] }),
      makeAspect('c', 'enforced', { implies: ['d'] }),
      makeAspect('d', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    const ids = [...computeEffectiveAspects(node, graph)];
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']);
    // Set semantics: no duplicates regardless of how many implies-paths reach d.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an aspect reachable both directly and via implies appears once', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
    ]);
    // 'b' is BOTH a direct own aspect and implied by 'a'.
    const node = makeNode('n', 'service', ['a', 'b']);
    graph.nodes.set('n', node);
    const ids = [...computeEffectiveAspects(node, graph)];
    expect(ids.filter((x) => x === 'b')).toHaveLength(1);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('wide fan-out: one implier implies many distinct children', () => {
    const graph = makeGraph([
      makeAspect('root', 'enforced', { implies: ['c1', 'c2', 'c3', 'c4'] }),
      makeAspect('c1', 'enforced'),
      makeAspect('c2', 'enforced'),
      makeAspect('c3', 'enforced'),
      makeAspect('c4', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['root']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['c1', 'c2', 'c3', 'c4', 'root']);
  });

  it('two independent roots both implying the same shared leaf — leaf appears once', () => {
    const graph = makeGraph([
      makeAspect('r1', 'enforced', { implies: ['shared'] }),
      makeAspect('r2', 'enforced', { implies: ['shared'] }),
      makeAspect('shared', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['r1', 'r2']);
    graph.nodes.set('n', node);
    const ids = [...computeEffectiveAspects(node, graph)];
    expect(ids.filter((x) => x === 'shared')).toHaveLength(1);
    expect(ids.sort()).toEqual(['r1', 'r2', 'shared']);
  });
});

// ===========================================================================
// 3. Aggregate aspects (no own reviewer) expanding implied children
// ===========================================================================

describe('channel 7 — aggregate aspects expand implied children', () => {
  it('isAggregateAspect distinguishes aggregate from llm', () => {
    const graph = makeGraph([
      makeAggregate('agg', ['child']),
      makeAspect('child', 'enforced'),
      makeAspect('llm', 'enforced'),
    ]);
    expect(isAggregateAspect(graph, 'agg')).toBe(true);
    expect(isAggregateAspect(graph, 'child')).toBe(false);
    expect(isAggregateAspect(graph, 'llm')).toBe(false);
  });

  it('isAggregateAspect returns false for an unknown aspect id', () => {
    const graph = makeGraph([makeAspect('a', 'enforced')]);
    expect(isAggregateAspect(graph, 'does-not-exist')).toBe(false);
  });

  it('aggregate is itself effective AND its children expand', () => {
    const graph = makeGraph([
      makeAggregate('agg', ['c1', 'c2']),
      makeAspect('c1', 'enforced'),
      makeAspect('c2', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    // The aggregate itself stays in the effective SET (it expands via channel 7),
    // along with its children.
    expect(effectiveIds(node, graph)).toEqual(['agg', 'c1', 'c2']);
  });

  it('aggregate has no own verdict but does NOT block hasNonDraftEffectiveAspects on its own', () => {
    // Node whose ONLY non-aggregate effective aspect is an effectively-DRAFT child.
    // The aggregate (enforced default) would, under strictest inherit, RAISE a
    // draft child to enforced — so to keep the child genuinely draft we declare
    // the implies edge as 'own-default', which lets the child keep its own draft
    // status. With the only real child draft and the aggregate excluded,
    // hasNonDraftEffectiveAspects must be false.
    const graph = makeGraph([
      makeAggregate('agg', ['c1'], { impliesStatusInherit: { c1: 'own-default' } }),
      makeAspect('c1', 'draft'),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('c1')).toBe('draft'); // own-default preserved the child's draft
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(false);
  });

  it('aggregate with a non-draft child makes the node have reviewer work', () => {
    const graph = makeGraph([
      makeAggregate('agg', ['c1']),
      makeAspect('c1', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(true);
  });

  it('aggregate-only node with no real children at all has no reviewer work', () => {
    // Aggregate that implies another aggregate which implies nothing concrete.
    const graph = makeGraph([
      makeAggregate('agg1', ['agg2']),
      makeAggregate('agg2', []),
    ]);
    const node = makeNode('n', 'service', ['agg1']);
    graph.nodes.set('n', node);
    // Both agg1 and agg2 are effective, but both are aggregates → excluded.
    expect(effectiveIds(node, graph)).toEqual(['agg1', 'agg2']);
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(false);
  });

  it('aggregate nested: agg -> agg -> concrete leaf expands recursively', () => {
    const graph = makeGraph([
      makeAggregate('outer', ['inner']),
      makeAggregate('inner', ['leaf']),
      makeAspect('leaf', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['outer']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['inner', 'leaf', 'outer']);
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(true);
  });

  it('aggregate child status defaults to enforced (no aspect status field on aggregate)', () => {
    // An aggregate's own status: makeAggregate omits `status`, so default is enforced.
    // Its implied enforced child must propagate as enforced.
    const graph = makeGraph([
      makeAggregate('agg', ['child']),
      makeAspect('child', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('agg')).toBe('enforced');
    expect(statuses.get('child')).toBe('enforced');
  });
});

// ===========================================================================
// 4. Cycle detection — ImpliesCycleError, never infinite loop
// ===========================================================================

describe('channel 7 — implies cycle detection', () => {
  it('direct 2-cycle A<->B throws ImpliesCycleError from computeEffectiveAspects', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['a'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  });

  it('self-cycle A->A throws ImpliesCycleError', () => {
    const graph = makeGraph([makeAspect('a', 'enforced', { implies: ['a'] })]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  });

  it('3-cycle A->B->C->A throws ImpliesCycleError', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'] }),
      makeAspect('c', 'enforced', { implies: ['a'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  });

  it('thrown error carries the aspect id where the cycle closes', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['a'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    let caught: unknown;
    try {
      computeEffectiveAspects(node, graph);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImpliesCycleError);
    expect((caught as ImpliesCycleError).aspectId).toBeDefined();
    expect((caught as ImpliesCycleError).name).toBe('ImpliesCycleError');
  });

  // computeEffectiveAspectStatuses intentionally does NOT throw on an implies
  // cycle — it is called by validation-path checks BEFORE the authoritative
  // cycle detector (checkImpliesNoCycles) runs, so it must not abort. Its
  // monotone (max-only) fix-point saturates and returns on an enforced A<->B
  // cycle. computeEffectiveAspects (DFS) DOES throw, but only on the wrapped
  // drift/approve paths. The two diverge on a cyclic graph BY DESIGN; the cyclic
  // graph is rejected with a blocking aspect-implies-cycle error by the validator.
  it('computeEffectiveAspectStatuses converges (does not throw, does not hang) on a saturating enforced cycle', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['a'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    // No infinite loop: the test completing (within vitest's per-test timeout)
    // is the termination guarantee — no wall-clock assertion needed.
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('enforced');
  });

  it('cycle terminates (does not hang) — computes within the per-test timeout', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'] }),
      makeAspect('c', 'enforced', { implies: ['a'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    // Termination is guaranteed by the 5s per-test timeout below, not a wall-clock assertion.
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  }, 5000);

  it('cycle reachable only deep in the chain (D->E->D) still detected', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'] }),
      makeAspect('c', 'enforced', { implies: ['d'] }),
      makeAspect('d', 'enforced', { implies: ['e'] }),
      makeAspect('e', 'enforced', { implies: ['d'] }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  });

  it('aggregate participating in a cycle is still detected', () => {
    const graph = makeGraph([
      makeAggregate('agg', ['b']),
      makeAspect('b', 'enforced', { implies: ['agg'] }),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).toThrow(ImpliesCycleError);
  });

  it('a self-cycle on a DRAFT aspect does NOT recurse (draft does not propagate) → no throw', () => {
    // The implies traversal is gated on the implier NOT being draft. A draft
    // aspect therefore never recurses into its implies, so even a self-cycle is
    // never entered.
    const graph = makeGraph([makeAspect('a', 'draft', { implies: ['a'] })]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(() => computeEffectiveAspects(node, graph)).not.toThrow();
    expect(effectiveIds(node, graph)).toEqual(['a']);
  });
});

// ===========================================================================
// 5. Draft-implier gating (channel 7 does not propagate from a draft implier)
// ===========================================================================

describe('channel 7 — draft implier does not propagate', () => {
  it('draft A does not pull in implied B (effective set)', () => {
    const graph = makeGraph([
      makeAspect('a', 'draft', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a']);
  });

  it('draft A blocks the rest of the chain (B and C not added)', () => {
    const graph = makeGraph([
      makeAspect('a', 'draft', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'] }),
      makeAspect('c', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a']);
  });

  it('mid-chain draft B halts propagation to C but A and B are present', () => {
    // A enforced implies B; B's *effective* status is draft (aspect default
    // draft, strictest with enforced implier would normally raise it...).
    // To get an effective DRAFT mid-chain we make B reachable only via an
    // own-default edge so it keeps its draft default.
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } }),
      makeAspect('b', 'draft', { implies: ['c'] }),
      makeAspect('c', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('draft');
    // B is effectively draft → it must NOT propagate to C.
    expect(statuses.has('c')).toBe(false);
    // And the id-only effective set must also omit c.
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
  });

  it('draft implier, but implied B arrives independently via a separate channel', () => {
    const graph = makeGraph([
      makeAspect('a', 'draft', { implies: ['b'] }),
      makeAspect('b', 'advisory'),
    ]);
    // b is also a direct own aspect → it is effective on its own.
    const node = makeNode('n', 'service', ['a', 'b']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('a')).toBe('draft');
    expect(statuses.get('b')).toBe('advisory');
  });
});

// ===========================================================================
// 6. when filtering on the implies path (global + per-implies edge)
// ===========================================================================

describe('channel 7 — when filters on the implies path', () => {
  it('implied B with a global when=false is filtered out (chain stops)', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { implies: ['c'], when: FALSE_FOR_SERVICE }),
      makeAspect('c', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    // b filtered → its subtree (c) not reached via b.
    expect(effectiveIds(node, graph)).toEqual(['a']);
  });

  it('implied B with a global when=true passes', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced', { when: TRUE_FOR_SERVICE }),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
  });

  it('per-implies edge when=false on A->B filters B', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', {
        implies: ['b'],
        impliesWhens: { b: FALSE_FOR_SERVICE },
      }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a']);
  });

  it('per-implies edge when=true on A->B keeps B', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', {
        implies: ['b'],
        impliesWhens: { b: TRUE_FOR_SERVICE },
      }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(effectiveIds(node, graph)).toEqual(['a', 'b']);
  });

  it('per-implies when filters B on one edge but B survives via another implier whose edge passes', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'], impliesWhens: { b: FALSE_FOR_SERVICE } }),
      makeAspect('x', 'enforced', { implies: ['b'] }), // unconditional edge to b
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a', 'x']);
    graph.nodes.set('n', node);
    // b is filtered on a->b but reachable via x->b.
    expect(effectiveIds(node, graph)).toEqual(['a', 'b', 'x']);
  });
});

// ===========================================================================
// 7. Provenance — getAspectSource for implied aspects (channel 7 label)
// ===========================================================================

describe('channel 7 — getAspectSource provenance', () => {
  it('reports "implied by" for an aspect only reachable via implies', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    expect(getAspectSource('b', node, graph)).toBe("implied by 'a'");
  });

  it('reports the aggregate as the implier for an aggregate-only child', () => {
    const graph = makeGraph([
      makeAggregate('agg', ['child']),
      makeAspect('child', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['agg']);
    graph.nodes.set('n', node);
    expect(getAspectSource('child', node, graph)).toBe("implied by 'agg'");
  });

  it('direct channel 1 wins over implied provenance for a doubly-reachable aspect', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a', 'b']);
    graph.nodes.set('n', node);
    // b is declared directly AND implied — the direct attachment is checked first.
    expect(getAspectSource('b', node, graph)).toBe('own declaration');
  });

  it('getAspectStatusSources never reports a channel-7 source (implies is not an attach)', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    // b is purely implied → no attach-site source.
    expect(getAspectStatusSources(node, 'b', graph)).toEqual([]);
  });
});

// ===========================================================================
// 8. Consistency between the id-set and the status-map for implies
// ===========================================================================

describe('channel 7 — id-set vs status-map consistency', () => {
  it('every effective id (implies chain) has a status entry', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b'] }),
      makeAspect('b', 'advisory', { implies: ['c'] }),
      makeAspect('c', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    const ids = computeEffectiveAspects(node, graph);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    for (const id of ids) {
      expect(statuses.has(id)).toBe(true);
    }
    expect(ids.size).toBe(statuses.size);
  });

  it('diamond: id-set and status-map keys agree', () => {
    const graph = makeGraph([
      makeAspect('a', 'enforced', { implies: ['b', 'c'] }),
      makeAspect('b', 'enforced', { implies: ['d'] }),
      makeAspect('c', 'enforced', { implies: ['d'] }),
      makeAspect('d', 'enforced'),
    ]);
    const node = makeNode('n', 'service', ['a']);
    graph.nodes.set('n', node);
    const ids = [...computeEffectiveAspects(node, graph)].sort();
    const statusKeys = [...computeEffectiveAspectStatuses(node, graph).keys()].sort();
    expect(ids).toEqual(statusKeys);
  });
});
