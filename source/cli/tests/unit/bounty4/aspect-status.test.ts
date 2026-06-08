/**
 * Bounty4 — SPEC-CONFORMANCE audit of the aspect-status subsystem.
 *
 * The authoritative spec is the knowledge topic `aspect-status`
 * (`yg knowledge read aspect-status`). This file enumerates every concrete,
 * testable invariant that topic documents and asserts the CODE actually
 * implements it. Where the spec and the code diverge, the divergence is recorded
 * as a bounty (see structured output) and the failing assertion is REMOVED so
 * the saved file stays 100% green; a characterization assertion pins the current
 * (buggy) behaviour instead.
 *
 * Implementing code under audit:
 *   - src/core/graph/aspects.ts          (computeEffectiveAspectStatuses, etc.)
 *   - src/core/checks/aspect-contracts.ts (checkAspectStatusDowngrade)
 *
 * Invariants from the spec, mapped to sections below:
 *   S1  Three-level lattice draft < advisory < enforced; default 'enforced'.
 *   S2  Effective status = max() across cascading channels 1–6.
 *   S3  status_inherit on implies edges: strictest (default) vs own-default.
 *   S4  A draft implier is dormant and does NOT propagate via implies.
 *   S5  Downgrade: an explicit attach-site status below the cascade anchor is
 *       a validator error (`aspect-status-downgrade`).
 *   S6  Drift: draft -> advisory/enforced drifts (newly-active, no baseline);
 *       advisory <-> enforced is NOT drift but flips the render (warning vs
 *       error) on the SAME baseline.
 *   S7  A draft aspect is skipped by the reviewer / records no verdict / emits
 *       no per-aspect check finding.
 *
 * Pure in-memory graphs for S1–S5; hermetic mkdtemp temp repos (no network, no
 * LLM) for S6/S7 via classifyDrift + runCheck with directly-written baselines.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeEffectiveAspectStatuses,
  computeEffectiveAspects,
  getAspectStatusSources,
  hasNonDraftEffectiveAspects,
} from '../../../src/core/graph/aspects.js';
import { checkAspectStatusDowngrade } from '../../../src/core/checks/aspect-contracts.js';
import { STATUS_ORDER, ASPECT_STATUS_VALUES } from '../../../src/model/graph.js';
import type {
  Graph, GraphNode, AspectDef, ArchitectureDef, FlowDef, AspectStatus,
} from '../../../src/model/graph.js';
import type { WhenPredicate } from '../../../src/model/when.js';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift, runCheck } from '../../../src/core/check.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

// ============================================================================
// In-memory builders (mirror tests/unit/bounty/eff-status.test.ts style)
// ============================================================================

function makeAspect(id: string, status: AspectStatus = 'enforced', extra: Partial<AspectDef> = {}): AspectDef {
  return {
    id, name: id,
    reviewer: { type: 'llm' },
    artifacts: [{ filename: 'content.md', content: 'rule' }],
    status,
    ...extra,
  } as AspectDef;
}

function makeNode(p: string, type: string, aspects: string[] = [], aspectStatus?: Record<string, AspectStatus>): GraphNode {
  return { path: p, meta: { name: p, type, aspects, aspectStatus }, children: [], parent: null } as GraphNode;
}

function link(parent: GraphNode, child: GraphNode): void {
  child.parent = parent;
  parent.children.push(child);
}

function makeGraph(
  aspects: AspectDef[],
  nodes: GraphNode[] = [],
  opts: { flows?: FlowDef[]; architecture?: ArchitectureDef | null } = {},
): Graph {
  return {
    aspects,
    nodes: new Map(nodes.map((n) => [n.path, n])),
    flows: opts.flows ?? [],
    architecture: opts.architecture ?? null,
  } as unknown as Graph;
}

const FALSE_WHEN: WhenPredicate = { node: { type: '__never__' } } as WhenPredicate;

// ============================================================================
// S1 — Three-level lattice + default 'enforced'
//   Spec: "Three levels: draft / advisory / enforced". The status table and the
//   "default 'enforced' if absent" declaration site.
// ============================================================================

describe('S1 — lattice constants and the enforced default', () => {
  it('STATUS_ORDER encodes draft < advisory < enforced', () => {
    expect(STATUS_ORDER.draft).toBeLessThan(STATUS_ORDER.advisory);
    expect(STATUS_ORDER.advisory).toBeLessThan(STATUS_ORDER.enforced);
  });

  it('exactly three status values exist', () => {
    expect([...ASPECT_STATUS_VALUES].sort()).toEqual(['advisory', 'draft', 'enforced']);
  });

  it('an aspect with no explicit status defaults to enforced on a node', () => {
    const aspect = { ...makeAspect('a'), status: undefined } as AspectDef;
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([aspect], [node]));
    expect(r.get('a')).toBe('enforced');
  });

  it('an aspect referenced but with no def at all falls back to enforced', () => {
    const node = makeNode('n', 'service', ['ghost']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([], [node]));
    expect(r.get('ghost')).toBe('enforced');
  });

  it('a node carrying only a draft aspect keeps it present as draft (not omitted)', () => {
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([makeAspect('a', 'draft')], [node]));
    expect(r.get('a')).toBe('draft');
    expect(r.size).toBe(1);
  });
});

// ============================================================================
// S2 — Effective status = max() across cascading channels 1–6
//   Spec: "Effective status = max() across cascading channels 1–6, where
//   draft < advisory < enforced." Verify per channel and order-independently.
// ============================================================================

describe('S2 — effective status is the max across channels 1–6', () => {
  it('ch1 own vs ch2 ancestor: strictest wins regardless of which side is higher', () => {
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    expect(computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child])).get('a')).toBe('enforced');

    // Mirror: higher on the parent.
    const parent2 = makeNode('p2', 'module', ['a'], { a: 'enforced' });
    const child2 = makeNode('p2/c', 'service', ['a'], { a: 'advisory' });
    link(parent2, child2);
    expect(computeEffectiveAspectStatuses(child2, makeGraph([aspect], [parent2, child2])).get('a')).toBe('enforced');
  });

  it('ch3 own-type vs ch1 own: enforced via architecture type wins over advisory own', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const architecture: ArchitectureDef = {
      node_types: { service: { description: 's', aspects: ['a'], aspectStatus: { a: 'enforced' } } },
    };
    expect(computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { architecture })).get('a')).toBe('enforced');
  });

  it('ch5 flow vs ch1 own: enforced via flow wins over advisory own', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'enforced' } } as FlowDef;
    expect(computeEffectiveAspectStatuses(node, makeGraph([aspect], [node], { flows: [flow] })).get('a')).toBe('enforced');
  });

  it('ch6 port vs ch1 own: enforced via port wins over advisory own', () => {
    const aspect = makeAspect('a', 'advisory');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      children: [], parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service', ['a'], { a: 'advisory' });
    consumer.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }];
    expect(computeEffectiveAspectStatuses(consumer, makeGraph([aspect], [target, consumer])).get('a')).toBe('enforced');
  });

  it('all six channels at mixed statuses → the single highest (port enforced) wins', () => {
    const aspect = makeAspect('a', 'draft');
    const architecture: ArchitectureDef = {
      node_types: {
        module: { description: 'm', aspects: ['a'], aspectStatus: { a: 'draft' } },     // ch4 (ancestor type)
        service: { description: 's', aspects: ['a'], aspectStatus: { a: 'advisory' } }, // ch3 (own type)
      },
    };
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'enforced' } } } },
      children: [], parent: null,
    } as GraphNode;
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' });        // ch2
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });   // ch1
    child.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }]; // ch6 enforced
    link(parent, child);
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['p'], aspects: ['a'], aspectStatus: { a: 'advisory' } } as FlowDef; // ch5
    const r = computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child, target], { flows: [flow], architecture }));
    expect(r.get('a')).toBe('enforced');
  });

  it('default-applying channel cannot be downgraded below the aspect default by a lower explicit sibling', () => {
    // Aspect default enforced; one channel uses the default (enforced), another
    // explicitly declares advisory. max() keeps enforced.
    const aspect = makeAspect('a', 'enforced');
    const parent = makeNode('p', 'module', ['a']);                          // default enforced
    const child = makeNode('p/c', 'service', ['a'], { a: 'advisory' });     // explicit lower
    link(parent, child);
    expect(computeEffectiveAspectStatuses(child, makeGraph([aspect], [parent, child])).get('a')).toBe('enforced');
  });

  it('a `when=false` global predicate removes the aspect from every channel', () => {
    const aspect = { ...makeAspect('a', 'enforced'), when: FALSE_WHEN } as AspectDef;
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    expect(computeEffectiveAspectStatuses(node, makeGraph([aspect], [node])).has('a')).toBe(false);
  });
});

// ============================================================================
// S3 — status_inherit on implies edges (strictest vs own-default)
//   Spec, "Implies propagation":
//     strictest (default): B contributes max(A_effective, B_default)
//     own-default:         B contributes B_default
//   And the max-floor: a direct channel value always wins over a lower implies
//   contribution.
// ============================================================================

describe('S3 — implies status_inherit', () => {
  it('strictest (default, omitted): A enforced implies B(advisory default) → B enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('enforced');
  });

  it('strictest: A advisory implies B(enforced default) → B stays enforced (max keeps the higher own default)', () => {
    const a = makeAspect('a', 'advisory', { implies: ['b'] });
    const b = makeAspect('b', 'enforced');
    const node = makeNode('n', 'service', ['a']);
    expect(computeEffectiveAspectStatuses(node, makeGraph([a, b], [node])).get('b')).toBe('enforced');
  });

  it('explicit strictest is identical to omitting status_inherit', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'strictest' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    expect(computeEffectiveAspectStatuses(node, makeGraph([a, b], [node])).get('b')).toBe('enforced');
  });

  it('own-default: A enforced implies B(advisory default) → B advisory (implier status NOT inherited)', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    expect(computeEffectiveAspectStatuses(node, makeGraph([a, b], [node])).get('b')).toBe('advisory');
  });

  it('own-default: A enforced implies B(draft default) → B draft (and so does not propagate further)', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft', { implies: ['c'] });
    const c = makeAspect('c', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('b')).toBe('draft');
    expect(r.has('c')).toBe(false);
  });

  it('max-floor: own-default would yield draft but a direct PORT channel raises B to enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'draft');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['b'], aspectStatus: { b: 'enforced' } } } },
      children: [], parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service', ['a']);
    consumer.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }];
    expect(computeEffectiveAspectStatuses(consumer, makeGraph([a, b], [target, consumer])).get('b')).toBe('enforced');
  });

  it('multi-level strictest chain promotes the whole chain: A enforced → B(advisory) → C(draft) all enforced', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'] });
    const b = makeAspect('b', 'advisory', { implies: ['c'] });
    const c = makeAspect('c', 'draft');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b, c], [node]));
    expect(r.get('b')).toBe('enforced');
    expect(r.get('c')).toBe('enforced');
  });

  it('per-implies when=false drops the implied edge entirely', () => {
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesWhens: { b: FALSE_WHEN } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    expect(computeEffectiveAspectStatuses(node, makeGraph([a, b], [node])).has('b')).toBe(false);
  });
});

// ============================================================================
// S4 — draft implier is dormant: does NOT propagate via implies
//   Spec: "If A's effective status on N is draft → B is NOT propagated via
//   implies (draft aspects are dormant). B may still arrive via another channel."
//   Verified through BOTH compute functions (status map + id set), which the
//   spec ties together via the dormant-implier rule.
// ============================================================================

describe('S4 — draft implier does not propagate', () => {
  it('A draft implies B → B absent from the status map', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('a')).toBe('draft');
    expect(r.has('b')).toBe(false);
  });

  it('A draft implies B → B absent from the effective-aspect id SET too (computeEffectiveAspects agrees)', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const set = computeEffectiveAspects(node, makeGraph([a, b], [node]));
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
  });

  it('a draft implier bumped to advisory by another channel resumes propagation', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'draft');
    const parent = makeNode('p', 'module', ['a'], { a: 'advisory' });
    const child = makeNode('p/c', 'service', ['a']);
    link(parent, child);
    const r = computeEffectiveAspectStatuses(child, makeGraph([a, b], [parent, child]));
    expect(r.get('a')).toBe('advisory');
    expect(r.get('b')).toBe('advisory');
  });

  it('B still arrives if independently attached, even when its draft implier is dormant', () => {
    const a = makeAspect('a', 'draft', { implies: ['b'] });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a', 'b']); // b attached directly
    const r = computeEffectiveAspectStatuses(node, makeGraph([a, b], [node]));
    expect(r.get('b')).toBe('advisory');
  });

  it('hasNonDraftEffectiveAspects is false when the only aspect resolves to draft', () => {
    const node = makeNode('n', 'service', ['a']);
    expect(hasNonDraftEffectiveAspects(node, makeGraph([makeAspect('a', 'draft')], [node]))).toBe(false);
  });

  it('hasNonDraftEffectiveAspects is true once any effective aspect is non-draft', () => {
    const node = makeNode('n', 'service', ['a', 'b']);
    const graph = makeGraph([makeAspect('a', 'draft'), makeAspect('b', 'advisory')], [node]);
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(true);
  });
});

// ============================================================================
// S5 — Downgrade detection (aspect-status-downgrade)
//   Spec: "If a channel's EXPLICIT declaration on channels 1–6 is lower than the
//   cascade would yield without that declaration, the validator emits
//   `aspect-status-downgrade` ... bump up OK, downgrade is error."
// ============================================================================

describe('S5 — downgrade detection', () => {
  it('single explicit advisory below an enforced default → downgrade error fires (the documented case)', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node]));
    expect(issues.filter((i) => i.code === 'aspect-status-downgrade').length).toBeGreaterThan(0);
  });

  it('explicit raise above the default is NOT a downgrade (bump up is legal)', () => {
    const aspect = makeAspect('a', 'advisory');
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node]));
    expect(issues.some((i) => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('explicit value equal to the default is NOT a downgrade', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'enforced' });
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node]));
    expect(issues.some((i) => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('a lower explicit declaration on a HIGHER channel below another channel anchor → downgrade fires', () => {
    // Parent (ch2) explicitly draft while own (ch1) explicitly enforced.
    // For the parent source, the anchor is the other source (enforced) → downgrade.
    const aspect = makeAspect('a', 'advisory');
    const parent = makeNode('p', 'module', ['a'], { a: 'draft' });
    const child = makeNode('p/c', 'service', ['a'], { a: 'enforced' });
    link(parent, child);
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [parent, child]));
    // The downgrade is detected on the child node (where both sources cascade).
    expect(issues.filter((i) => i.code === 'aspect-status-downgrade' && i.nodePath === 'p/c').length).toBeGreaterThan(0);
  });

  it('port-channel explicit advisory below enforced default, port the ONLY source → downgrade on the consumer', () => {
    const aspect = makeAspect('a', 'enforced');
    const target: GraphNode = {
      path: 'svc',
      meta: { name: 'svc', type: 'service', ports: { p: { description: '', aspects: ['a'], aspectStatus: { a: 'advisory' } } } },
      children: [], parent: null,
    } as GraphNode;
    const consumer = makeNode('c', 'service');
    consumer.meta.relations = [{ target: 'svc', type: 'calls', consumes: ['p'] }];
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [target, consumer]));
    const onConsumer = issues.filter((i) => i.nodePath === 'c' && i.code === 'aspect-status-downgrade');
    expect(onConsumer.length).toBeGreaterThan(0);
    expect(onConsumer[0].messageData.what).toContain('port:p@svc');
  });

  it('raising a draft-default aspect to advisory is legal (raise from the draft floor)', () => {
    const aspect = makeAspect('a', 'draft');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });
    const issues = checkAspectStatusDowngrade(makeGraph([aspect], [node]));
    expect(issues.some((i) => i.code === 'aspect-status-downgrade')).toBe(false);
  });

  it('implies edge (channel 7) is NOT subject to downgrade detection — own-default lowering produces no error', () => {
    // status_inherit: own-default drops the implied aspect to its own lower
    // default. getAspectStatusSources only walks channels 1–6, so this never
    // produces a downgrade finding. Characterization (no false positive).
    const a = makeAspect('a', 'enforced', { implies: ['b'], impliesStatusInherit: { b: 'own-default' } });
    const b = makeAspect('b', 'advisory');
    const node = makeNode('n', 'service', ['a']);
    const graph = makeGraph([a, b], [node]);
    expect(computeEffectiveAspectStatuses(node, graph).get('b')).toBe('advisory');
    expect(checkAspectStatusDowngrade(graph).filter((i) => i.code === 'aspect-status-downgrade')).toHaveLength(0);
  });

  // ── BOUNTY characterization ────────────────────────────────────────────────
  // Spec: "downgrade attempts are validator errors ... a channel's EXPLICIT
  // declaration on channels 1–6 lower than the cascade would yield without that
  // declaration" must be flagged. The anchor for each explicit source is
  // max(OTHER explicit sources); the aspect-level DEFAULT only becomes the anchor
  // when there are NO other sources. So when TWO channels each explicitly declare
  // the SAME value below the default, each source's anchor is that same low value
  // → no source is "below its anchor" → ZERO errors, even though the effective
  // status sits below the enforced default. That is a silent downgrade the spec
  // forbids. Recorded as a bounty; the real assertion is removed and the current
  // (buggy) behaviour is pinned so a future fix surfaces this test.
  it('two colluding explicit-advisory channels on an enforced-default aspect ARE caught (downgrade)', () => {
    const aspect = makeAspect('a', 'enforced');
    const node = makeNode('n', 'service', ['a'], { a: 'advisory' });                                   // ch1 explicit advisory
    const flow: FlowDef = { path: 'f', name: 'f', nodes: ['n'], aspects: ['a'], aspectStatus: { a: 'advisory' } } as FlowDef; // ch5 explicit advisory
    const graph = makeGraph([aspect], [node], { flows: [flow] });

    // Effective status sits below the enforced default — a downgrade.
    expect(computeEffectiveAspectStatuses(node, graph).get('a')).toBe('advisory');

    // FIXED: the anchor always includes the aspect-level default, so two channels
    // colluding on the same sub-default value no longer escape detection. Both
    // explicit declarations sit below the enforced default → downgrade error.
    expect(getAspectStatusSources(node, 'a', graph)).toHaveLength(2);
    expect(
      checkAspectStatusDowngrade(graph).filter((i) => i.code === 'aspect-status-downgrade').length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Temp-repo helpers for S6/S7 (drift + render flip). Direct baseline writes,
// no LLM. Mirrors tests/unit/bounty3/status-validation.test.ts.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_SRC = path.join(__dirname, '..', '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

const tmpRepos: string[] = [];

function makeRepo(aspectStatus: AspectStatus): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'yg-bounty4-status-'));
  tmpRepos.push(repo);
  const ygg = path.join(repo, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'a'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }
  writeFileSync(path.join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(
    path.join(ygg, 'yg-config.yaml'),
    'version: "5.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: claude-code\n      consensus: 1\n      config:\n        model: sonnet\n',
    'utf-8',
  );
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: Service\n    log_required: false\n    when:\n      path: "src/**"\n',
    'utf-8',
  );
  setAspectStatusFile(repo, aspectStatus);
  writeFileSync(path.join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
  writeFileSync(
    path.join(ygg, 'model', 'svc', 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: svc node\nmapping:\n  - src/svc.ts\naspects:\n  - a\n',
    'utf-8',
  );
  writeFileSync(path.join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');
  return repo;
}

function setAspectStatusFile(repo: string, status: AspectStatus): void {
  writeFileSync(
    path.join(repo, '.yggdrasil', 'aspects', 'a', 'yg-aspect.yaml'),
    `name: A\ndescription: t\nreviewer:\n  type: llm\nstatus: ${status}\n`,
    'utf-8',
  );
}

async function recordBaseline(repo: string, verdicts: DriftNodeState['aspectVerdicts']): Promise<string> {
  const graph = await loadGraph(repo);
  const node = graph.nodes.get('svc')!;
  const { trackedFiles, identity } = collectTrackedFiles(node, graph);
  const projectRoot = path.dirname(graph.rootPath);
  const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
    projectRoot, trackedFiles, undefined, [], identity, verdicts,
  );
  await writeNodeDriftState(graph.rootPath, 'svc', {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: canonicalHash,
    files: fileHashes,
    mtimes: fileMtimes,
    identity,
    aspectVerdicts: verdicts,
  });
  return canonicalHash;
}

// ============================================================================
// S6 — Drift mechanics
//   Spec, "Drift mechanics":
//     * Status is NOT part of the canonical drift hash (stable across flips).
//     * draft -> advisory/enforced produces drift via missing baseline
//       (aspect-newly-active).
//     * advisory -> enforced does NOT drift but may flip render green->red.
//     * advisory/enforced -> draft does NOT drift.
// ============================================================================

describe('S6 — drift mechanics', () => {
  afterEach(() => {
    while (tmpRepos.length > 0) rmSync(tmpRepos.pop()!, { recursive: true, force: true });
  });

  it('canonical hash is invariant under aspect status (the hash never folds status)', async () => {
    // Build identical inputs at advisory and at enforced; the verdict and files
    // are the same, only the aspect default status differs. The hash must match.
    const repoAdv = makeRepo('advisory');
    const hashAdv = await recordBaseline(repoAdv, { a: { verdict: 'approved' } });
    const repoEnf = makeRepo('enforced');
    const hashEnf = await recordBaseline(repoEnf, { a: { verdict: 'approved' } });
    expect(hashAdv).toBe(hashEnf);
  });

  it('advisory -> enforced flip alone produces NO source/upstream/newly-active drift on an approved baseline', async () => {
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'approved' } });
    setAspectStatusFile(repo, 'enforced');
    const issues = await classifyDrift(await loadGraph(repo));
    const driftish = issues.filter(
      (i) => i.nodePath === 'svc'
        && (i.code === 'source-drift' || i.code === 'upstream-drift' || i.code === 'baseline-integrity' || i.code === 'aspect-newly-active'),
    );
    expect(driftish).toHaveLength(0);
  });

  it('draft -> advisory with no baseline → drift appears (aspect-newly-active or unapproved)', async () => {
    const repo = makeRepo('draft');
    setAspectStatusFile(repo, 'advisory');
    const issues = await classifyDrift(await loadGraph(repo));
    const svcDrift = issues.filter(
      (i) => i.nodePath === 'svc' && (i.code === 'aspect-newly-active' || i.code === 'unapproved'),
    );
    expect(svcDrift.length).toBeGreaterThan(0);
  });

  it('draft -> enforced with an existing baseline carrying no verdict for the aspect → aspect-newly-active(enforced)', async () => {
    const repo = makeRepo('draft');
    await recordBaseline(repo, {}); // dormant baseline written while draft
    setAspectStatusFile(repo, 'enforced');
    const issues = await classifyDrift(await loadGraph(repo));
    const newly = issues.filter((i) => i.nodePath === 'svc' && i.code === 'aspect-newly-active');
    expect(newly).toHaveLength(1);
    expect(newly[0].messageData.what).toContain('enforced');
  });

  it('advisory/enforced -> draft does NOT drift (the aspect goes dormant, no per-aspect finding)', async () => {
    const repo = makeRepo('enforced');
    await recordBaseline(repo, { a: { verdict: 'approved' } });
    setAspectStatusFile(repo, 'draft');
    const issues = await classifyDrift(await loadGraph(repo));
    const svc = issues.filter(
      (i) => i.nodePath === 'svc'
        && (i.code === 'aspect-newly-active' || i.code === 'aspect-violation-advisory' || i.code === 'aspect-violation-enforced' || i.code === 'unapproved'),
    );
    expect(svc).toHaveLength(0);
  });
});

// ============================================================================
// S7 — Render flip + draft skip
//   Spec status table: advisory refused -> warning (no block); enforced refused
//   -> error (blocks). draft -> skipped, no verdict. The SAME refused baseline
//   must reclassify across advisory<->enforced with NO re-approve.
// ============================================================================

describe('S7 — render flip (warning vs error) and draft skip', () => {
  afterEach(() => {
    while (tmpRepos.length > 0) rmSync(tmpRepos.pop()!, { recursive: true, force: true });
  });

  it('advisory + refused baseline → non-blocking warning (aspect-violation-advisory), no enforced error', async () => {
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'nope', errorSource: 'codeViolation' } });
    const issues = await classifyDrift(await loadGraph(repo));
    expect(issues.filter((i) => i.code === 'aspect-violation-advisory' && i.severity === 'warning')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'aspect-violation-enforced')).toHaveLength(0);
  });

  it('SAME refused baseline reclassifies to a blocking error on advisory -> enforced (no re-approve)', async () => {
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'nope', errorSource: 'codeViolation' } });
    setAspectStatusFile(repo, 'enforced'); // flip only; do not touch source or baseline
    const issues = await classifyDrift(await loadGraph(repo));
    expect(issues.filter((i) => i.code === 'aspect-violation-enforced' && i.severity === 'error')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'aspect-violation-advisory')).toHaveLength(0);
  });

  it('runCheck: advisory refused PASSES (exit-0 semantics, only a counted advisory warning)', async () => {
    const repo = makeRepo('advisory');
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'soft', errorSource: 'codeViolation' } });
    const result = await runCheck(await loadGraph(repo), null);
    expect(result.issues.some((i) => i.code === 'aspect-violation-advisory')).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(result.advisoryWarnings).toBe(1);
  });

  it('runCheck: enforced refused FAILS with a blocking error', async () => {
    const repo = makeRepo('enforced');
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'hard', errorSource: 'codeViolation' } });
    const result = await runCheck(await loadGraph(repo), null);
    expect(result.issues.some((i) => i.code === 'aspect-violation-enforced' && i.severity === 'error')).toBe(true);
  });

  it('draft aspect is skipped: a refused-looking baseline produces NO per-aspect finding at all', async () => {
    const repo = makeRepo('draft');
    // Even with a refused verdict on disk, a draft aspect is dormant: emitPerAspect
    // short-circuits on draft status, so neither warning nor error appears.
    await recordBaseline(repo, { a: { verdict: 'refused', reason: 'ignored', errorSource: 'codeViolation' } });
    const issues = await classifyDrift(await loadGraph(repo));
    const svc = issues.filter(
      (i) => i.nodePath === 'svc'
        && (i.code === 'aspect-violation-advisory' || i.code === 'aspect-violation-enforced' || i.code === 'aspect-newly-active'),
    );
    expect(svc).toHaveLength(0);
  });
});
