import { describe, it, expect } from 'vitest';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
} from '../../../src/core/graph/aspects.js';
import { collectParticipatingFlows } from '../../../src/core/graph/flows.js';
import { buildTestGraph } from '../helpers/build-test-graph.js';
import type { Graph, GraphNode, AspectDef, FlowDef, WhenPredicate } from '../../../src/model/graph.js';

// ============================================================================
// BOUNTY: channel 5 — flow-level aspects.
//
// Surface under test:
//   - flow aspects propagate to DECLARED participant nodes
//   - flow aspects propagate to DESCENDANTS of declared participants (any depth)
//   - a node participating in MULTIPLE flows accumulates aspects from all
//   - a flow with NO aspects contributes nothing
//   - descendant auto-inclusion at arbitrary depth
//   - status semantics on channel 5 (declared status, default, max() combine)
//   - provenance labels: getAspectSource + getAspectStatusSources
//   - collectParticipatingFlows mirror of the channel-5 match rule
//
// Assertions encode CORRECT behavior (docs/code intent). Where assertions
// could not be satisfied because the code is genuinely wrong, the bounty is
// recorded in structured output and the offending assertion removed.
// ============================================================================

// ---- low-level builders for cases the helper cannot express (flow whens, etc.) ----

function aspect(over: Partial<AspectDef> & { id: string }): AspectDef {
  return {
    name: over.id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    ...over,
  } as AspectDef;
}

/** Link a list of [path, type] into a single parent->child chain (first is root). */
function chain(specs: { path: string; type: string; aspects?: string[] }[]): {
  byPath: Map<string, GraphNode>;
  leaf: GraphNode;
  root: GraphNode;
} {
  const byPath = new Map<string, GraphNode>();
  let prev: GraphNode | null = null;
  let root: GraphNode | null = null;
  for (const s of specs) {
    const n: GraphNode = {
      path: s.path,
      meta: { name: s.path, type: s.type, aspects: s.aspects },
      children: [],
      parent: prev,
    } as GraphNode;
    if (prev) prev.children.push(n);
    if (!root) root = n;
    byPath.set(s.path, n);
    prev = n;
  }
  return { byPath, leaf: prev!, root: root! };
}

function makeGraph(opts: {
  nodes: Map<string, GraphNode>;
  aspects: AspectDef[];
  flows: FlowDef[];
}): Graph {
  return {
    config: {},
    architecture: { node_types: { service: { description: '' }, module: { description: '' } } },
    nodes: opts.nodes,
    aspects: opts.aspects,
    flows: opts.flows,
    rootPath: '/tmp',
  } as unknown as Graph;
}

// ============================================================================
// 1. Flow aspect reaches a DIRECTLY declared participant node
// ============================================================================

describe('channel 5 — direct participant', () => {
  function setup(): { graph: Graph; node: GraphNode } {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'] }],
    });
    return { graph, node: graph.nodes.get('svc')! };
  }

  it('flow aspect is effective on a directly-declared participant', () => {
    const { graph, node } = setup();
    expect(computeEffectiveAspects(node, graph).has('F')).toBe(true);
  });

  it('only the declared aspect is effective (no leakage)', () => {
    const { graph, node } = setup();
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['F']);
  });

  it('getAspectSource labels a direct participant as flow \'<path>\' (no via-parent)', () => {
    const { graph, node } = setup();
    expect(getAspectSource('F', node, graph)).toBe("flow 'flow1'");
  });

  it('getAspectStatusSources reports channel 5 with flow:<path> origin', () => {
    const { graph, node } = setup();
    expect(getAspectStatusSources(node, 'F', graph)).toEqual([
      { channel: 5, declared: 'enforced', origin: 'flow:flow1' },
    ]);
  });

  it('status defaults to the aspect default (enforced) when flow declares none', () => {
    const { graph, node } = setup();
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('enforced');
  });
});

// ============================================================================
// 2. Flow aspect reaches a DESCENDANT of a declared participant (depth 1)
// ============================================================================

describe('channel 5 — descendant of declared participant (depth 1)', () => {
  function setup(): { graph: Graph; parent: GraphNode; child: GraphNode } {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      // flow declares only the PARENT
      flows: [{ path: 'flow1', nodes: ['mod'], aspects: ['F'] }],
    });
    return { graph, parent: graph.nodes.get('mod')!, child: graph.nodes.get('mod/svc')! };
  }

  it('flow aspect cascades to the child of a declared participant', () => {
    const { graph, child } = setup();
    expect(computeEffectiveAspects(child, graph).has('F')).toBe(true);
  });

  it('the declared parent itself also carries the flow aspect', () => {
    const { graph, parent } = setup();
    expect(computeEffectiveAspects(parent, graph).has('F')).toBe(true);
  });

  it('getAspectSource on the descendant uses the via-parent label', () => {
    const { graph, child } = setup();
    expect(getAspectSource('F', child, graph)).toBe("flow 'flow1' (via parent 'mod')");
  });

  it('getAspectSource on the declared parent uses the plain flow label', () => {
    const { graph, parent } = setup();
    expect(getAspectSource('F', parent, graph)).toBe("flow 'flow1'");
  });

  it('getAspectStatusSources on the descendant still reports channel 5 / flow:<path>', () => {
    const { graph, child } = setup();
    expect(getAspectStatusSources(child, 'F', graph)).toEqual([
      { channel: 5, declared: 'enforced', origin: 'flow:flow1' },
    ]);
  });
});

// ============================================================================
// 3. Descendant auto-inclusion at arbitrary DEPTH
// ============================================================================

describe('channel 5 — descendant auto-inclusion depth', () => {
  function deepGraph(): { graph: Graph; byPath: Map<string, GraphNode> } {
    // root -> a -> b -> c -> d (depth 4 from root)
    const { byPath } = chain([
      { path: 'root', type: 'module' },
      { path: 'root/a', type: 'module' },
      { path: 'root/a/b', type: 'module' },
      { path: 'root/a/b/c', type: 'module' },
      { path: 'root/a/b/c/d', type: 'service' },
    ]);
    const graph = makeGraph({
      nodes: byPath,
      aspects: [aspect({ id: 'F', status: 'enforced' })],
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['root'], aspects: ['F'] } as FlowDef],
    });
    return { graph, byPath };
  }

  it('flow declared on the root reaches a depth-4 descendant', () => {
    const { graph, byPath } = deepGraph();
    expect(computeEffectiveAspects(byPath.get('root/a/b/c/d')!, graph).has('F')).toBe(true);
  });

  it('every intermediate descendant also carries the flow aspect', () => {
    const { graph, byPath } = deepGraph();
    for (const p of ['root', 'root/a', 'root/a/b', 'root/a/b/c', 'root/a/b/c/d']) {
      expect(computeEffectiveAspects(byPath.get(p)!, graph).has('F')).toBe(true);
    }
  });

  it('deep descendant via-parent label names the DECLARED participant (the matching ancestor), not the immediate parent', () => {
    const { graph, byPath } = deepGraph();
    expect(getAspectSource('F', byPath.get('root/a/b/c/d')!, graph)).toBe("flow 'flow1' (via parent 'root')");
  });

  it('flow declared mid-chain does NOT reach ancestors above it', () => {
    const { byPath } = chain([
      { path: 'root', type: 'module' },
      { path: 'root/a', type: 'module' },
      { path: 'root/a/b', type: 'service' },
    ]);
    const graph = makeGraph({
      nodes: byPath,
      aspects: [aspect({ id: 'F', status: 'enforced' })],
      // declare the MIDDLE node
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['root/a'], aspects: ['F'] } as FlowDef],
    });
    // ancestor 'root' is above the declared node -> NOT a participant
    expect(computeEffectiveAspects(byPath.get('root')!, graph).has('F')).toBe(false);
    // declared node + its descendant DO carry it
    expect(computeEffectiveAspects(byPath.get('root/a')!, graph).has('F')).toBe(true);
    expect(computeEffectiveAspects(byPath.get('root/a/b')!, graph).has('F')).toBe(true);
  });

  it('a sibling subtree of the declared participant is unaffected', () => {
    // root -> {x (declared), y (sibling)}; x -> x1 ; y -> y1
    const root: GraphNode = { path: 'root', meta: { name: 'root', type: 'module' }, children: [], parent: null } as GraphNode;
    const x: GraphNode = { path: 'root/x', meta: { name: 'x', type: 'module' }, children: [], parent: root } as GraphNode;
    const y: GraphNode = { path: 'root/y', meta: { name: 'y', type: 'module' }, children: [], parent: root } as GraphNode;
    const x1: GraphNode = { path: 'root/x/x1', meta: { name: 'x1', type: 'service' }, children: [], parent: x } as GraphNode;
    const y1: GraphNode = { path: 'root/y/y1', meta: { name: 'y1', type: 'service' }, children: [], parent: y } as GraphNode;
    root.children = [x, y];
    x.children = [x1];
    y.children = [y1];
    const nodes = new Map<string, GraphNode>([
      ['root', root], ['root/x', x], ['root/y', y], ['root/x/x1', x1], ['root/y/y1', y1],
    ]);
    const graph = makeGraph({
      nodes,
      aspects: [aspect({ id: 'F', status: 'enforced' })],
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['root/x'], aspects: ['F'] } as FlowDef],
    });
    expect(computeEffectiveAspects(x, graph).has('F')).toBe(true);
    expect(computeEffectiveAspects(x1, graph).has('F')).toBe(true);
    expect(computeEffectiveAspects(y, graph).has('F')).toBe(false);
    expect(computeEffectiveAspects(y1, graph).has('F')).toBe(false);
    // 'root' is an ancestor of the declared 'root/x', NOT a descendant -> excluded
    expect(computeEffectiveAspects(root, graph).has('F')).toBe(false);
  });
});

// ============================================================================
// 4. A node participating in MULTIPLE flows
// ============================================================================

describe('channel 5 — node in multiple flows', () => {
  it('aspects from all participating flows accumulate on the node', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F1', status: 'enforced' },
        { id: 'F2', status: 'enforced' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'flowA', nodes: ['svc'], aspects: ['F1'] },
        { path: 'flowB', nodes: ['svc'], aspects: ['F2'] },
      ],
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['F1', 'F2']);
  });

  it('same aspect declared in two flows yields a single effective entry', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'flowA', nodes: ['svc'], aspects: ['F'] },
        { path: 'flowB', nodes: ['svc'], aspects: ['F'] },
      ],
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)].filter((id) => id === 'F')).toHaveLength(1);
  });

  it('same aspect from two flows: getAspectStatusSources lists BOTH flow channels', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'flowA', nodes: ['svc'], aspects: ['F'] },
        { path: 'flowB', nodes: ['svc'], aspects: ['F'] },
      ],
    });
    const node = graph.nodes.get('svc')!;
    const srcs = getAspectStatusSources(node, 'F', graph);
    expect(srcs.map((s) => s.origin).sort()).toEqual(['flow:flowA', 'flow:flowB']);
    expect(srcs.every((s) => s.channel === 5)).toBe(true);
  });

  it('multi-flow status combine takes the strictest (max) when the two declare different statuses', () => {
    // flowA declares advisory, flowB declares enforced -> effective enforced
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'draft' }], // base default is low; flows override up
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'flowA', nodes: ['svc'], aspects: ['F'], aspectStatus: { F: 'advisory' } },
        { path: 'flowB', nodes: ['svc'], aspects: ['F'], aspectStatus: { F: 'enforced' } },
      ],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('enforced');
  });

  it('getAspectSource returns the FIRST participating flow in graph order', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'flowA', nodes: ['svc'], aspects: ['F'] },
        { path: 'flowB', nodes: ['svc'], aspects: ['F'] },
      ],
    });
    const node = graph.nodes.get('svc')!;
    expect(getAspectSource('F', node, graph)).toBe("flow 'flowA'");
  });

  it('node directly in one flow AND a descendant in another: both aspects effective, mixed labels', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'FD', status: 'enforced' }, // declared directly on child
        { id: 'FA', status: 'enforced' }, // declared on parent (ancestor) -> via-parent
      ],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      flows: [
        { path: 'flowDirect', nodes: ['mod/svc'], aspects: ['FD'] },
        { path: 'flowAnc', nodes: ['mod'], aspects: ['FA'] },
      ],
    });
    const child = graph.nodes.get('mod/svc')!;
    expect([...computeEffectiveAspects(child, graph)].sort()).toEqual(['FA', 'FD']);
    expect(getAspectSource('FD', child, graph)).toBe("flow 'flowDirect'");
    expect(getAspectSource('FA', child, graph)).toBe("flow 'flowAnc' (via parent 'mod')");
  });
});

// ============================================================================
// 5. Flow with NO aspects
// ============================================================================

describe('channel 5 — flow with no aspects', () => {
  it('a participant of an aspect-less flow gains nothing', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'] }], // no aspects key
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)]).toEqual([]);
  });

  it('aspect-less flow yields empty status map for any aspect', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspectStatuses(node, graph).has('F')).toBe(false);
  });

  it('flow with an explicitly empty aspects array contributes nothing', () => {
    const graph = makeGraph({
      nodes: chain([{ path: 'svc', type: 'service' }]).byPath,
      aspects: [],
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['svc'], aspects: [] } as FlowDef],
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)]).toEqual([]);
  });

  it('a node NOT listed in any flow gains nothing from a populated flow', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [
        { path: 'svc', type: 'service' },
        { path: 'other', type: 'service' },
      ],
      flows: [{ path: 'flow1', nodes: ['other'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspects(node, graph).has('F')).toBe(false);
  });
});

// ============================================================================
// 6. Status semantics on channel 5
// ============================================================================

describe('channel 5 — status semantics', () => {
  it('flow attach-site status override is honored (advisory below the aspect default)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'], aspectStatus: { F: 'advisory' } }],
    });
    const node = graph.nodes.get('svc')!;
    // Only channel is the flow; its declared status wins (advisory).
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('advisory');
    expect(getAspectStatusSources(node, 'F', graph)).toEqual([
      { channel: 5, declared: 'advisory', origin: 'flow:flow1' },
    ]);
  });

  it('a draft-by-default aspect attached only via a flow stays draft (no enforcement)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'draft' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('draft');
  });

  it('flow status combines with an OWN attach via max() — own enforced beats flow advisory', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service', aspects: ['F'], aspectStatus: { F: 'enforced' } }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'], aspectStatus: { F: 'advisory' } }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('enforced');
    // Both channels show up as sources (1 own + 5 flow).
    const channels = getAspectStatusSources(node, 'F', graph).map((s) => s.channel).sort();
    expect(channels).toEqual([1, 5]);
  });

  it('flow declaring a higher status than an own advisory raises effective status to flow status', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service', aspects: ['F'], aspectStatus: { F: 'advisory' } }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'], aspectStatus: { F: 'enforced' } }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('enforced');
  });
});

// ============================================================================
// 7. when-filtered flow attach (deterministic applicability per channel)
// ============================================================================

describe('channel 5 — when filter on the flow attach site', () => {
  // attach-site when that only matches type 'service'
  const onlyService: WhenPredicate = { node: { type: 'service' } } as unknown as WhenPredicate;

  function setup(): { graph: Graph; svc: GraphNode; mod: GraphNode } {
    const { byPath } = chain([
      { path: 'mod', type: 'module' },
      { path: 'mod/svc', type: 'service' },
    ]);
    const flow: FlowDef = {
      path: 'flow1',
      name: 'flow1',
      nodes: ['mod'],
      aspects: ['F'],
      aspectWhens: { F: onlyService },
    } as FlowDef;
    const graph = makeGraph({
      nodes: byPath,
      aspects: [aspect({ id: 'F', status: 'enforced' })],
      flows: [flow],
    });
    return { graph, svc: byPath.get('mod/svc')!, mod: byPath.get('mod')! };
  }

  it('flow attach when=type:service applies to the service descendant', () => {
    const { graph, svc } = setup();
    expect(computeEffectiveAspects(svc, graph).has('F')).toBe(true);
  });

  it('flow attach when=type:service filters OUT the module participant itself', () => {
    const { graph, mod } = setup();
    expect(computeEffectiveAspects(mod, graph).has('F')).toBe(false);
  });

  it('filtered-out node has no channel-5 status source', () => {
    const { graph, mod } = setup();
    expect(getAspectStatusSources(mod, 'F', graph)).toEqual([]);
  });

  it('passing node has the channel-5 status source', () => {
    const { graph, svc } = setup();
    expect(getAspectStatusSources(svc, 'F', graph)).toEqual([
      { channel: 5, declared: 'enforced', origin: 'flow:flow1' },
    ]);
  });

  it('aspect global when filters the flow attach as well', () => {
    const { byPath } = chain([{ path: 'svc', type: 'service' }]);
    const moduleOnly: WhenPredicate = { node: { type: 'module' } } as unknown as WhenPredicate;
    const graph = makeGraph({
      nodes: byPath,
      aspects: [aspect({ id: 'F', status: 'enforced', when: moduleOnly })],
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['svc'], aspects: ['F'] } as FlowDef],
    });
    const node = byPath.get('svc')!;
    // global when (type module) is false for a service -> filtered everywhere
    expect(computeEffectiveAspects(node, graph).has('F')).toBe(false);
  });
});

// ============================================================================
// 8. Flow + implies interplay (channel 5 feeds the implies expansion)
// ============================================================================

describe('channel 5 — flow aspect that implies another', () => {
  it('an implied aspect reaches the participant through a flow-attached implier', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F', status: 'enforced', implies: ['G'] },
        { id: 'G', status: 'enforced' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['F', 'G']);
  });

  it('implied aspect via flow is also reflected in the descendant subtree', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F', status: 'enforced', implies: ['G'] },
        { id: 'G', status: 'enforced' },
      ],
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      flows: [{ path: 'flow1', nodes: ['mod'], aspects: ['F'] }],
    });
    const child = graph.nodes.get('mod/svc')!;
    expect([...computeEffectiveAspects(child, graph)].sort()).toEqual(['F', 'G']);
  });

  it('a draft flow-attached implier does NOT propagate its implied aspect', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F', status: 'draft', implies: ['G'] },
        { id: 'G', status: 'enforced' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    const eff = computeEffectiveAspects(node, graph);
    expect(eff.has('F')).toBe(true);   // F itself still effective (just dormant)
    expect(eff.has('G')).toBe(false);  // draft implier does not propagate
  });

  it('implied aspect (channel 7) is NOT reported as a flow status source — only the implier is', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F', status: 'enforced', implies: ['G'] },
        { id: 'G', status: 'enforced' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    // G has no direct attach (channels 1-6) -> getAspectStatusSources is empty
    expect(getAspectStatusSources(node, 'G', graph)).toEqual([]);
    // but getAspectSource attributes it to the implier
    expect(getAspectSource('G', node, graph)).toBe("implied by 'F'");
  });
});

// ============================================================================
// 9. collectParticipatingFlows — mirror of the channel-5 match rule
// ============================================================================

describe('collectParticipatingFlows', () => {
  it('returns the flow when the node is directly declared', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: [] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(collectParticipatingFlows(graph, node).map((f) => f.path)).toEqual(['flow1']);
  });

  it('returns the flow when an ANCESTOR is declared (descendant participation)', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      flows: [{ path: 'flow1', nodes: ['mod'], aspects: [] }],
    });
    const child = graph.nodes.get('mod/svc')!;
    expect(collectParticipatingFlows(graph, child).map((f) => f.path)).toEqual(['flow1']);
  });

  it('does NOT return a flow that declares only a descendant of the node', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      // flow declares the child; the PARENT is an ancestor, not a participant
      flows: [{ path: 'flow1', nodes: ['mod/svc'], aspects: [] }],
    });
    const parent = graph.nodes.get('mod')!;
    expect(collectParticipatingFlows(graph, parent)).toEqual([]);
  });

  it('returns ALL participating flows in graph order', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [
        { path: 'alpha', nodes: ['svc'], aspects: [] },
        { path: 'beta', nodes: ['other'], aspects: [] },
        { path: 'gamma', nodes: ['svc'], aspects: [] },
      ],
    });
    const node = graph.nodes.get('svc')!;
    expect(collectParticipatingFlows(graph, node).map((f) => f.path)).toEqual(['alpha', 'gamma']);
  });

  it('returns [] when the node participates in no flow', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['other'], aspects: [] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(collectParticipatingFlows(graph, node)).toEqual([]);
  });

  it('returns [] for a graph with no flows at all', () => {
    const graph = buildTestGraph({
      nodes: [{ path: 'svc', type: 'service' }],
    });
    const node = graph.nodes.get('svc')!;
    expect(collectParticipatingFlows(graph, node)).toEqual([]);
  });

  it('counts a node listed redundantly (self + ancestor) as a single flow entry', () => {
    const graph = buildTestGraph({
      nodes: [
        { path: 'mod', type: 'module' },
        { path: 'mod/svc', type: 'service', parent: 'mod' },
      ],
      // flow names BOTH the node and its ancestor
      flows: [{ path: 'flow1', nodes: ['mod', 'mod/svc'], aspects: [] }],
    });
    const child = graph.nodes.get('mod/svc')!;
    expect(collectParticipatingFlows(graph, child).map((f) => f.path)).toEqual(['flow1']);
  });
});

// ============================================================================
// 10. Edge cases — dangling references, empty nodes, redundant listing
// ============================================================================

describe('channel 5 — edge cases', () => {
  it('flow listing a non-existent node path matches nothing (no crash)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['ghost'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspects(node, graph).has('F')).toBe(false);
  });

  it('flow declaring an aspect id that is not defined still attaches the id (effective set), unknown default status enforced', () => {
    // F is declared on the flow but absent from graph.aspects — the channel walk
    // attaches the id regardless; the missing-aspect default status is 'enforced'.
    const graph = makeGraph({
      nodes: chain([{ path: 'svc', type: 'service' }]).byPath,
      aspects: [], // F intentionally undefined
      flows: [{ path: 'flow1', name: 'flow1', nodes: ['svc'], aspects: ['F'] } as FlowDef],
    });
    const node = graph.nodes.get('svc')!;
    expect(computeEffectiveAspects(node, graph).has('F')).toBe(true);
    expect(computeEffectiveAspectStatuses(node, graph).get('F')).toBe('enforced');
  });

  it('same node listed twice in one flow yields a single channel-5 status source', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'F', status: 'enforced' }],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc', 'svc'], aspects: ['F'] }],
    });
    const node = graph.nodes.get('svc')!;
    // The channel walk iterates flow.aspects once per flow (not per node entry),
    // so a single source regardless of duplicate node listing.
    expect(getAspectStatusSources(node, 'F', graph)).toEqual([
      { channel: 5, declared: 'enforced', origin: 'flow:flow1' },
    ]);
  });

  it('flow with multiple aspects attaches all of them to a participant', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'F1', status: 'enforced' },
        { id: 'F2', status: 'advisory' },
        { id: 'F3', status: 'draft' },
      ],
      nodes: [{ path: 'svc', type: 'service' }],
      flows: [{ path: 'flow1', nodes: ['svc'], aspects: ['F1', 'F2', 'F3'] }],
    });
    const node = graph.nodes.get('svc')!;
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['F1', 'F2', 'F3']);
    const statuses = computeEffectiveAspectStatuses(node, graph);
    expect(statuses.get('F1')).toBe('enforced');
    expect(statuses.get('F2')).toBe('advisory');
    expect(statuses.get('F3')).toBe('draft');
  });
});
