import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  getAspectSource,
  getAspectStatusSources,
} from '../../../src/core/graph/aspects.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import {
  buildTestGraph,
  cleanupTestGraphs,
} from '../helpers/build-test-graph.js';
import type {
  Graph,
  GraphNode,
  AspectDef,
  ArchitectureDef,
  AspectStatus,
} from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

// ============================================================================
// BOUNTY: effective aspects — type defaults (channels 3 + 4)
//
// Channel 3 = own node-type default aspects (architecture.node_types[node.type].aspects)
// Channel 4 = ancestor node-type default aspects (each ancestor's type contributes)
//
// Exhaustive coverage of: a type with defaults, a node whose ancestor type has
// defaults, dedup vs own (channel 1), organizational types with NO defaults,
// per-type aspectStatus / aspectWhens overrides, multi-level hierarchies, the
// human + machine provenance labels, and the architecture-parser path that
// produces these type-default structures.
// ============================================================================

afterEach(() => {
  cleanupTestGraphs();
});

// ----------------------------------------------------------------------------
// Local in-memory builders (mirror existing test style in
// tests/unit/core/graph/aspect-status.test.ts).
// ----------------------------------------------------------------------------

function makeAspect(
  id: string,
  status: AspectStatus = 'enforced',
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

function makeNode(
  path: string,
  type: string,
  aspects: string[] = [],
  aspectStatus?: Record<string, AspectStatus>,
): GraphNode {
  return {
    path,
    meta: { name: path, type, aspects, aspectStatus },
    children: [],
    parent: null,
  } as GraphNode;
}

function link(parent: GraphNode, child: GraphNode): void {
  child.parent = parent;
  parent.children.push(child);
}

/**
 * Build a graph with an explicit architecture. `makeGraph` in the sibling
 * status test sets architecture to null; here we always want a real
 * architecture so channels 3/4 actually fire.
 */
function makeGraph(
  aspects: AspectDef[],
  nodes: GraphNode[],
  architecture: ArchitectureDef,
  flows: Graph['flows'] = [],
): Graph {
  return {
    aspects,
    nodes: new Map(nodes.map((n) => [n.path, n])),
    flows,
    architecture,
    schemas: [],
    rootPath: '/tmp',
    config: {},
  } as unknown as Graph;
}

// A `when` predicate that is FALSE for a node of type 'service'
// (it requires type 'command'), and TRUE for a node of type 'command'.
const REQUIRE_COMMAND: WhenPredicate = { node: { type: 'command' } } as WhenPredicate;
const REQUIRE_SERVICE: WhenPredicate = { node: { type: 'service' } } as WhenPredicate;

// ============================================================================
// Channel 3 — own node-type defaults
// ============================================================================

describe('channel 3 — own node-type default aspects', () => {
  it('a type with one default → effective on a node of that type', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['type-default'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('type-default')], [node], arch);
    expect([...computeEffectiveAspects(node, graph)]).toEqual(['type-default']);
  });

  it('a type with multiple defaults → all effective', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a', 'b', 'c'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph(
      [makeAspect('a'), makeAspect('b'), makeAspect('c')],
      [node],
      arch,
    );
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('default does NOT reach a node of a DIFFERENT type', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: { description: 'svc', aspects: ['svc-only'] },
        module: { description: 'mod' },
      },
    };
    const node = makeNode('n', 'module');
    const graph = makeGraph([makeAspect('svc-only')], [node], arch);
    expect(computeEffectiveAspects(node, graph).has('svc-only')).toBe(false);
  });

  it('type default carries the aspect-default status (advisory)', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'advisory')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('advisory');
  });

  it('type default carries the aspect-default status (draft)', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'draft')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('draft');
  });

  it('per-type aspectStatus override raises status above aspect default (bump)', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: { description: 'svc', aspects: ['a'], aspectStatus: { a: 'enforced' } },
      },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'advisory')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('enforced');
  });

  it('per-type aspectStatus override of draft default → advisory', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: { description: 'svc', aspects: ['a'], aspectStatus: { a: 'advisory' } },
      },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'draft')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('advisory');
  });

  it('per-type aspectWhens=false suppresses the type default entirely', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: {
          description: 'svc',
          aspects: ['a'],
          aspectWhens: { a: REQUIRE_COMMAND },
        },
      },
    };
    const node = makeNode('n', 'service'); // not 'command' → when false
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
    expect(computeEffectiveAspectStatuses(node, graph).has('a')).toBe(false);
  });

  it('per-type aspectWhens=true keeps the type default', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: {
          description: 'svc',
          aspects: ['a'],
          aspectWhens: { a: REQUIRE_SERVICE },
        },
      },
    };
    const node = makeNode('n', 'service'); // matches → when true
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it("global aspect when=false suppresses the type default", () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph(
      [makeAspect('a', 'enforced', { when: REQUIRE_COMMAND })],
      [node],
      arch,
    );
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('getAspectSource → "architecture (type: <type>)" for a channel-3 default', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(getAspectSource('a', node, graph)).toBe('architecture (type: service)');
  });

  it('getAspectStatusSources → channel 3, origin type:<type>, declared = aspect default', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'advisory')], [node], arch);
    const sources = getAspectStatusSources(node, 'a', graph);
    expect(sources).toHaveLength(1);
    expect(sources[0].channel).toBe(3);
    expect(sources[0].origin).toBe('type:service');
    expect(sources[0].declared).toBe('advisory');
  });

  it('getAspectStatusSources → channel 3 declared reflects per-type aspectStatus override', () => {
    const arch: ArchitectureDef = {
      node_types: {
        service: { description: 'svc', aspects: ['a'], aspectStatus: { a: 'enforced' } },
      },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'advisory')], [node], arch);
    const sources = getAspectStatusSources(node, 'a', graph);
    expect(sources[0].declared).toBe('enforced');
  });

  it('unknown node type (not in architecture.node_types) contributes nothing', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['a'] } },
    };
    const node = makeNode('n', 'ghost-type'); // type absent from node_types
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(computeEffectiveAspects(node, graph).size).toBe(0);
    expect(getAspectStatusSources(node, 'a', graph)).toEqual([]);
  });

  it('type present but with no aspects field contributes nothing', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc' } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(computeEffectiveAspects(node, graph).size).toBe(0);
  });

  it('missing architecture entirely → no channel-3 contribution, no throw', () => {
    const node = makeNode('n', 'service', ['own']);
    // architecture undefined
    const graph = {
      aspects: [makeAspect('own')],
      nodes: new Map([[node.path, node]]),
      flows: [],
      schemas: [],
      rootPath: '/tmp',
      config: {},
    } as unknown as Graph;
    // own aspect (channel 1) still effective, no type contribution
    expect([...computeEffectiveAspects(node, graph)]).toEqual(['own']);
  });
});

// ============================================================================
// Channel 4 — ancestor node-type defaults
// ============================================================================

describe('channel 4 — ancestor node-type default aspects', () => {
  it('a node whose PARENT type has a default → default is effective on the child', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['parent-type-default'] },
        service: { description: 'svc' },
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph(
      [makeAspect('parent-type-default')],
      [parent, child],
      arch,
    );
    expect(computeEffectiveAspects(child, graph).has('parent-type-default')).toBe(true);
  });

  it('parent type default is NOT effective on the parent itself via channel 4 (only via channel 3)', () => {
    const arch: ArchitectureDef = {
      node_types: { module: { description: 'mod', aspects: ['a'] }, service: { description: 'svc' } },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('a')], [parent, child], arch);
    // On the parent, 'a' arrives via channel 3 (own type), origin = architecture
    expect(getAspectSource('a', parent, graph)).toBe('architecture (type: module)');
    // On the child, 'a' arrives via channel 4 (ancestor type)
    expect(getAspectSource('a', child, graph)).toBe('inherited from parent (type: module)');
  });

  it('grandparent type default cascades to a grandchild (two-level ancestry)', () => {
    const arch: ArchitectureDef = {
      node_types: {
        domain: { description: 'dom', aspects: ['gp-default'] },
        module: { description: 'mod' },
        service: { description: 'svc' },
      },
    };
    const gp = makeNode('g', 'domain');
    const parent = makeNode('g/p', 'module');
    const child = makeNode('g/p/c', 'service');
    link(gp, parent);
    link(parent, child);
    const graph = makeGraph([makeAspect('gp-default')], [gp, parent, child], arch);
    expect(computeEffectiveAspects(child, graph).has('gp-default')).toBe(true);
    expect(getAspectSource('gp-default', child, graph)).toBe(
      'inherited from parent (type: domain)',
    );
  });

  it('BOTH grandparent and parent type defaults are effective on the grandchild', () => {
    const arch: ArchitectureDef = {
      node_types: {
        domain: { description: 'dom', aspects: ['gp'] },
        module: { description: 'mod', aspects: ['p'] },
        service: { description: 'svc' },
      },
    };
    const gp = makeNode('g', 'domain');
    const parent = makeNode('g/p', 'module');
    const child = makeNode('g/p/c', 'service');
    link(gp, parent);
    link(parent, child);
    const graph = makeGraph(
      [makeAspect('gp'), makeAspect('p')],
      [gp, parent, child],
      arch,
    );
    expect([...computeEffectiveAspects(child, graph)].sort()).toEqual(['gp', 'p']);
  });

  it('channel 4 carries the aspect-default status', () => {
    const arch: ArchitectureDef = {
      node_types: { module: { description: 'mod', aspects: ['a'] }, service: { description: 'svc' } },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('a', 'advisory')], [parent, child], arch);
    expect(computeEffectiveAspectStatuses(child, graph).get('a')).toBe('advisory');
  });

  it('channel 4 honors per-type aspectStatus override on the ancestor type', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['a'], aspectStatus: { a: 'enforced' } },
        service: { description: 'svc' },
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('a', 'advisory')], [parent, child], arch);
    expect(computeEffectiveAspectStatuses(child, graph).get('a')).toBe('enforced');
  });

  it('channel 4 aspectWhens=false on the ancestor type suppresses the cascade', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['a'], aspectWhens: { a: REQUIRE_COMMAND } },
        service: { description: 'svc' },
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service'); // not command → suppressed
    link(parent, child);
    const graph = makeGraph([makeAspect('a')], [parent, child], arch);
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(false);
  });

  it('getAspectStatusSources → channel 4 origin is "ancestor-type:<type>@<path>"', () => {
    const arch: ArchitectureDef = {
      node_types: { module: { description: 'mod', aspects: ['a'] }, service: { description: 'svc' } },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('a', 'advisory')], [parent, child], arch);
    const sources = getAspectStatusSources(child, 'a', graph);
    expect(sources).toHaveLength(1);
    expect(sources[0].channel).toBe(4);
    expect(sources[0].origin).toBe('ancestor-type:module@p');
    expect(sources[0].declared).toBe('advisory');
  });

  it('two ancestors of the SAME type yield two distinct channel-4 sources (per @path)', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['a'], aspectStatus: { a: 'advisory' } },
        service: { description: 'svc' },
      },
    };
    const gp = makeNode('g', 'module');
    const parent = makeNode('g/p', 'module');
    const child = makeNode('g/p/c', 'service');
    link(gp, parent);
    link(parent, child);
    const graph = makeGraph([makeAspect('a', 'advisory')], [gp, parent, child], arch);
    const sources = getAspectStatusSources(child, 'a', graph).filter((s) => s.channel === 4);
    const origins = sources.map((s) => s.origin).sort();
    expect(origins).toEqual(['ancestor-type:module@g', 'ancestor-type:module@g/p']);
  });

  it('an ancestor whose type is unknown contributes nothing via channel 4', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc' } },
    };
    const parent = makeNode('p', 'ghost'); // type absent from node_types
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('a')], [parent, child], arch);
    expect(getAspectStatusSources(child, 'a', graph)).toEqual([]);
  });
});

// ============================================================================
// Dedup vs own (channel 1) and cross-channel status aggregation
// ============================================================================

describe('dedup — type default vs own / parent', () => {
  it('same aspect via own (ch.1) AND own type (ch.3) → effective ONCE', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['shared'] } },
    };
    const node = makeNode('n', 'service', ['shared']);
    const graph = makeGraph([makeAspect('shared')], [node], arch);
    expect([...computeEffectiveAspects(node, graph)]).toEqual(['shared']);
  });

  it('own (ch.1) + own-type (ch.3) → status is the STRICTEST of the two', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['shared'] } },
    };
    // own declares advisory; type default carries aspect default = enforced → enforced wins
    const node = makeNode('n', 'service', ['shared'], { shared: 'advisory' });
    const graph = makeGraph([makeAspect('shared', 'enforced')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('shared')).toBe('enforced');
  });

  it('own (ch.1) advisory + own-type (ch.3) advisory → advisory (no spurious bump)', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['shared'] } },
    };
    const node = makeNode('n', 'service', ['shared']);
    const graph = makeGraph([makeAspect('shared', 'advisory')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('shared')).toBe('advisory');
  });

  it('own (ch.1) AND own-type (ch.3) BOTH emit AttachSources (dedup is in effective set, not provenance)', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['shared'] } },
    };
    const node = makeNode('n', 'service', ['shared']);
    const graph = makeGraph([makeAspect('shared', 'advisory')], [node], arch);
    const channels = getAspectStatusSources(node, 'shared', graph)
      .map((s) => s.channel)
      .sort();
    expect(channels).toEqual([1, 3]);
  });

  it('getAspectSource returns the FIRST channel (own beats own-type)', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['shared'] } },
    };
    const node = makeNode('n', 'service', ['shared']);
    const graph = makeGraph([makeAspect('shared')], [node], arch);
    // channel walk order: own (1) before own-type (3) → own declaration
    expect(getAspectSource('shared', node, graph)).toBe('own declaration');
  });

  it('same aspect via parent type (ch.4) AND own type (ch.3) → effective once, strictest status', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['x'] }, // ch.4 on child, carries aspect default (enforced)
        service: { description: 'svc', aspects: ['x'], aspectStatus: { x: 'advisory' } }, // ch.3 advisory override
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    // aspect default is enforced; ch.3 downgrades its own declaration to advisory,
    // but ch.4 (no per-type override) carries the enforced default → strictest = enforced.
    const graph = makeGraph([makeAspect('x', 'enforced')], [parent, child], arch);
    expect([...computeEffectiveAspects(child, graph)]).toEqual(['x']);
    expect(computeEffectiveAspectStatuses(child, graph).get('x')).toBe('enforced');
    const channels = getAspectStatusSources(child, 'x', graph).map((s) => s.channel).sort();
    expect(channels).toEqual([3, 4]);
  });

  it('getAspectSource prefers own-type (ch.3) over ancestor-type (ch.4) for the same aspect', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['x'] },
        service: { description: 'svc', aspects: ['x'] },
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('x')], [parent, child], arch);
    // walk order: own-type (3) comes before ancestor-type (4)
    expect(getAspectSource('x', child, graph)).toBe('architecture (type: service)');
  });
});

// ============================================================================
// Organizational types (no defaults)
// ============================================================================

describe('organizational types — no defaults contribute nothing', () => {
  it('organizational parent type (no aspects) → child inherits nothing via channel 4', () => {
    const arch: ArchitectureDef = {
      node_types: {
        group: { description: 'organizational, parent-only' }, // no aspects
        service: { description: 'svc' },
      },
    };
    const parent = makeNode('p', 'group');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([], [parent, child], arch);
    expect(computeEffectiveAspects(child, graph).size).toBe(0);
  });

  it('organizational own type → node has no channel-3 aspects', () => {
    const arch: ArchitectureDef = {
      node_types: { group: { description: 'organizational' } },
    };
    const node = makeNode('n', 'group');
    const graph = makeGraph([], [node], arch);
    expect(computeEffectiveAspects(node, graph).size).toBe(0);
    expect(computeEffectiveAspectStatuses(node, graph).size).toBe(0);
  });

  it('organizational parent + a child type WITH a default → only the child-type default is effective', () => {
    const arch: ArchitectureDef = {
      node_types: {
        group: { description: 'organizational' },
        service: { description: 'svc', aspects: ['svc-default'] },
      },
    };
    const parent = makeNode('p', 'group');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('svc-default')], [parent, child], arch);
    expect([...computeEffectiveAspects(child, graph)]).toEqual(['svc-default']);
    expect(getAspectSource('svc-default', child, graph)).toBe(
      'architecture (type: service)',
    );
  });
});

// ============================================================================
// Implies expansion FROM a type default (channel 3 feeds channel 7)
// ============================================================================

describe('type default that implies another aspect', () => {
  it('channel-3 default with implies expands the implied aspect onto the node', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['agg'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph(
      [makeAspect('agg', 'enforced', { implies: ['child'] }), makeAspect('child', 'advisory')],
      [node],
      arch,
    );
    expect([...computeEffectiveAspects(node, graph)].sort()).toEqual(['agg', 'child']);
    // strictest: enforced implier (default strictest) raises advisory child → enforced
    expect(computeEffectiveAspectStatuses(node, graph).get('child')).toBe('enforced');
  });

  it('a DRAFT channel-3 default does NOT propagate its implied aspect', () => {
    const arch: ArchitectureDef = {
      node_types: { service: { description: 'svc', aspects: ['agg'] } },
    };
    const node = makeNode('n', 'service');
    const graph = makeGraph(
      [makeAspect('agg', 'draft', { implies: ['child'] }), makeAspect('child', 'advisory')],
      [node],
      arch,
    );
    expect(computeEffectiveAspects(node, graph).has('child')).toBe(false);
  });

  it('channel-4 ancestor-type default with implies expands onto the child', () => {
    const arch: ArchitectureDef = {
      node_types: {
        module: { description: 'mod', aspects: ['agg'] },
        service: { description: 'svc' },
      },
    };
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph(
      [makeAspect('agg', 'enforced', { implies: ['child'] }), makeAspect('child', 'advisory')],
      [parent, child],
      arch,
    );
    expect([...computeEffectiveAspects(child, graph)].sort()).toEqual(['agg', 'child']);
  });
});

// ============================================================================
// Cross-check via the shared buildTestGraph helper (matches repo test style)
// ============================================================================

describe('buildTestGraph integration — type defaults', () => {
  it('type with aspects → effective on a node of that type (channel 3)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a' }],
      types: [{ id: 'widget', aspects: ['a'] }],
      nodes: [{ path: 'n', type: 'widget' }],
    });
    const node = graph.nodes.get('n')!;
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(true);
  });

  it('ancestor type with aspects → effective on child (channel 4)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a' }],
      types: [{ id: 'box', aspects: ['a'] }],
      nodes: [
        { path: 'p', type: 'box' },
        { path: 'p/c', type: 'service', parent: 'p' },
      ],
    });
    const child = graph.nodes.get('p/c')!;
    expect(computeEffectiveAspects(child, graph).has('a')).toBe(true);
    expect(getAspectStatusSources(child, 'a', graph)[0].origin).toBe('ancestor-type:box@p');
  });

  it('per-type aspectStatus via buildTestGraph bumps the effective status', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a', status: 'advisory' }],
      types: [{ id: 'widget', aspects: ['a'], aspectStatus: { a: 'enforced' } }],
      nodes: [{ path: 'n', type: 'widget' }],
    });
    const node = graph.nodes.get('n')!;
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('enforced');
  });

  it('default-helper service/module types carry no aspects → no channel-3 contribution', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'a' }],
      nodes: [{ path: 'n', type: 'service' }],
    });
    const node = graph.nodes.get('n')!;
    expect(computeEffectiveAspects(node, graph).size).toBe(0);
  });
});

// ============================================================================
// Architecture-parser path — produces the channel 3/4 structures
// ============================================================================

describe('parseArchitecture — type-default aspect parsing', () => {
  let dir: string;

  async function write(yaml: string): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-bounty-'));
    const file = path.join(dir, 'yg-architecture.yaml');
    await writeFile(file, yaml, 'utf-8');
    return file;
  }

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('bare-string aspect list → aspects array, no whens/status', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: a service',
        '    aspects:',
        '      - a',
        '      - b',
        '',
      ].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toEqual(['a', 'b']);
    expect(arch.node_types.service.aspectWhens).toBeUndefined();
    expect(arch.node_types.service.aspectStatus).toBeUndefined();
  });

  it('object-form aspect with status → aspectStatus populated (drives channel 3 declared)', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: a service',
        '    aspects:',
        '      - id: a',
        '        status: enforced',
        '',
      ].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toEqual(['a']);
    expect(arch.node_types.service.aspectStatus).toEqual({ a: 'enforced' });

    // End-to-end: the parsed structure drives channel-3 status.
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a', 'advisory')], [node], arch);
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('enforced');
  });

  it('object-form aspect with when → aspectWhens populated (drives channel-3 applicability)', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: a service',
        '    aspects:',
        '      - id: a',
        '        when:',
        '          node:',
        '            type: command',
        '',
      ].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toEqual(['a']);
    expect(arch.node_types.service.aspectWhens).toBeDefined();
    expect(arch.node_types.service.aspectWhens!.a).toBeDefined();

    // when requires type 'command'; our node is 'service' → suppressed.
    const node = makeNode('n', 'service');
    const graph = makeGraph([makeAspect('a')], [node], arch);
    expect(computeEffectiveAspects(node, graph).has('a')).toBe(false);
  });

  it('empty aspects array → normalized to undefined (no channel-3 contribution)', async () => {
    const file = await write(
      ['node_types:', '  service:', '    description: a service', '    aspects: []', ''].join(
        '\n',
      ),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toBeUndefined();
  });

  it('type with no aspects key → aspects undefined', async () => {
    const file = await write(
      ['node_types:', '  service:', '    description: a service', ''].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toBeUndefined();
  });

  it('mixed bare + object aspects on one type parse together', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: a service',
        '    aspects:',
        '      - plain',
        '      - id: with-status',
        '        status: advisory',
        '',
      ].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toEqual(['plain', 'with-status']);
    expect(arch.node_types.service.aspectStatus).toEqual({ 'with-status': 'advisory' });
  });

  it('invalid per-type aspect status value → parse throws', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: a service',
        '    aspects:',
        '      - id: a',
        '        status: bogus',
        '',
      ].join('\n'),
    );
    await expect(parseArchitecture(file)).rejects.toThrow(/status must be one of/);
  });

  it('two types each with their own defaults parse independently', async () => {
    const file = await write(
      [
        'node_types:',
        '  service:',
        '    description: svc',
        '    aspects:',
        '      - sa',
        '  module:',
        '    description: mod',
        '    aspects:',
        '      - ma',
        '',
      ].join('\n'),
    );
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.aspects).toEqual(['sa']);
    expect(arch.node_types.module.aspects).toEqual(['ma']);

    // End-to-end channel 3 + 4: module parent, service child.
    const parent = makeNode('p', 'module');
    const child = makeNode('p/c', 'service');
    link(parent, child);
    const graph = makeGraph([makeAspect('sa'), makeAspect('ma')], [parent, child], arch);
    expect([...computeEffectiveAspects(child, graph)].sort()).toEqual(['ma', 'sa']);
  });
});
