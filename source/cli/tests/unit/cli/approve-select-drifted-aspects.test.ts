import { describe, it, expect } from 'vitest';
import { selectDriftedAspects } from '../../../src/cli/approve.js';
import { computeEffectiveAspects } from '../../../src/core/graph/aspects.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import type { ApproveResult, DriftNodeState, AnnotatedChange } from '../../../src/model/drift.js';

// ── Fixture ──────────────────────────────────────────────────
//
// Unlike filterAspectCascadeNodes (which only reads graph.aspects), the
// decision function under test also calls computeEffectiveAspects /
// computeEffectiveAspectStatuses, which walk the 7 channels. A bare
// `{ aspects: [...] } as Graph` cast yields empty effective sets and every
// case wrongly returns undefined. So we hand-build a real Graph where the
// three test aspects are OWN-DECLARED on the node (channel 1) — deterministic,
// no architecture defaults needed.

const NODE_PATH = 'orders/handler';
const PARENT_PATH = 'orders';

function aspectDef(id: string, type: 'llm' | 'deterministic'): AspectDef {
  return {
    id,
    name: id,
    reviewer: { type },
    artifacts: [],
  };
}

function makeGraph(ownAspects: string[], aspects: AspectDef[]): { graph: Graph; node: GraphNode } {
  const node: GraphNode = {
    path: NODE_PATH,
    meta: { name: 'handler', type: 'command', aspects: ownAspects },
    children: [],
    parent: null,
  };
  const nodes = new Map<string, GraphNode>([[NODE_PATH, node]]);
  const graph = {
    nodes,
    aspects,
    flows: [],
    architecture: { node_types: {} },
  } as unknown as Graph;
  return { graph, node };
}

function upstream(...paths: string[]): AnnotatedChange[] {
  return paths.map(p => ({ filePath: p, annotation: 'x' }));
}

function approveResult(over: Partial<ApproveResult>): ApproveResult {
  return { action: 'no-change', currentHash: 'h', ...over };
}

const STORED: DriftNodeState = {
  hash: 'h',
  files: {},
  aspectVerdicts: {
    det: { verdict: 'approved' },
    llmA: { verdict: 'approved' },
    llmB: { verdict: 'approved' },
  },
};

describe('selectDriftedAspects', () => {
  const aspects = [
    aspectDef('det', 'deterministic'),
    aspectDef('llmA', 'llm'),
    aspectDef('llmB', 'llm'),
  ];

  // Sanity: verify the fixture wires up channel 1 before testing the SUT.
  it('fixture sanity: computeEffectiveAspects returns the three own aspects', () => {
    const { graph, node } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    expect(computeEffectiveAspects(node, graph)).toEqual(new Set(['det', 'llmA', 'llmB']));
  });

  it('attributes an aspects/<id>/ prefix change to that aspect (det)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/det/yg-aspect.yaml'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toEqual(
      new Set(['det']),
    );
  });

  it('attributes a content.md change under aspects/<id>/ (llmA)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/llmA/content.md'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toEqual(
      new Set(['llmA']),
    );
  });

  it('attributes a synthetic tier-identity key to its aspect (llmA)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('tier-identity:llmA'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toEqual(
      new Set(['llmA']),
    );
  });

  it('returns undefined when source changed (conservative full re-run)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedSource: ['source/cli/src/x.ts'],
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toBeUndefined();
  });

  it('returns undefined for an un-attributable hierarchy change (parent yg-node.yaml)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream(`.yggdrasil/model/${PARENT_PATH}/yg-node.yaml`),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toBeUndefined();
  });

  // Negative control: the path is NOT in any aspect's structureTouchedFiles
  // (STORED has none) → un-attributable → undefined. Must keep passing after the fix.
  it('returns undefined for a bare cross-node source path in changedUpstream (structure-touched)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('source/cli/src/other/foo.ts'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toBeUndefined();
  });

  // Case A: a cross-node file present in the baseline's structureTouchedFiles[det]
  // changed. Attributable to the deterministic aspect 'det' → returns Set(['det']),
  // NOT undefined, NOT the llm aspects (which carry forward).
  it('attributes a structure-touched cross-node path to its deterministic aspect (det)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const storedWithTouched: DriftNodeState = {
      ...STORED,
      structureTouchedFiles: {
        det: { 'source/cli/src/other/reader.ts': 'deadbeef' },
      },
    };
    const result = approveResult({
      changedUpstream: upstream('source/cli/src/other/reader.ts'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, storedWithTouched, '.yggdrasil')).toEqual(
      new Set(['det']),
    );
  });

  it('returns undefined when storedEntry is undefined', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/det/yg-aspect.yaml'),
    });
    expect(selectDriftedAspects(graph, NODE_PATH, result, undefined, '.yggdrasil')).toBeUndefined();
  });

  it('returns undefined when storedEntry.aspectVerdicts is undefined (back-compat)', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/det/yg-aspect.yaml'),
    });
    const noVerdicts: DriftNodeState = { hash: 'h', files: {} };
    expect(selectDriftedAspects(graph, NODE_PATH, result, noVerdicts, '.yggdrasil')).toBeUndefined();
  });

  it('always re-runs a newly-attached aspect with no prior verdict (llmC) alongside the attributed one', () => {
    const aspectsWithC = [...aspects, aspectDef('llmC', 'llm')];
    const { graph } = makeGraph(['det', 'llmA', 'llmB', 'llmC'], aspectsWithC);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/det/yg-aspect.yaml'),
    });
    // storedEntry (STORED) lacks llmC → it must be re-run too.
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toEqual(
      new Set(['det', 'llmC']),
    );
  });

  it('returns an empty Set when nothing changed', () => {
    const { graph } = makeGraph(['det', 'llmA', 'llmB'], aspects);
    const result = approveResult({});
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toEqual(new Set());
  });

  it('monotonicity: every returned Set is a subset of effective aspects and contains no draft id', () => {
    const draftAspects = [
      aspectDef('det', 'deterministic'),
      aspectDef('llmA', 'llm'),
      aspectDef('llmB', 'llm'),
      { ...aspectDef('llmD', 'llm'), status: 'draft' as const },
    ];
    const { graph, node } = makeGraph(['det', 'llmA', 'llmB', 'llmD'], draftAspects);
    const effective = computeEffectiveAspects(node, graph);

    const cases: ApproveResult[] = [
      approveResult({ changedUpstream: upstream('.yggdrasil/aspects/det/yg-aspect.yaml') }),
      approveResult({ changedUpstream: upstream('.yggdrasil/aspects/llmA/content.md') }),
      approveResult({ changedUpstream: upstream('tier-identity:llmA') }),
      approveResult({}),
    ];
    for (const result of cases) {
      const subset = selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil');
      if (subset === undefined) continue;
      for (const id of subset) {
        expect(effective.has(id)).toBe(true);
        expect(id).not.toBe('llmD'); // draft must never be selected
      }
    }
  });

  it('does not select a draft aspect even when its own files change', () => {
    const draftAspects = [
      aspectDef('det', 'deterministic'),
      aspectDef('llmA', 'llm'),
      aspectDef('llmB', 'llm'),
      { ...aspectDef('llmD', 'llm'), status: 'draft' as const },
    ];
    const { graph } = makeGraph(['det', 'llmA', 'llmB', 'llmD'], draftAspects);
    const result = approveResult({
      changedUpstream: upstream('.yggdrasil/aspects/llmD/content.md'),
    });
    // The only change is to a draft aspect → no non-draft owner → undefined (conservative).
    expect(selectDriftedAspects(graph, NODE_PATH, result, STORED, '.yggdrasil')).toBeUndefined();
  });
});
