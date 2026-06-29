import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { readLock } from '../../src/io/lock-store.js';
import { verifyLock } from '../../src/core/verify-lock.js';
import { readLogContent } from '../../src/core/log/log-gate.js';
import { buildPortalNodes, type SuppressionsByFile } from '../../src/portal/derive-nodes.js';
import type { PortalNode, PortalSuppression } from '../../src/portal/contract.js';
import type { Graph, GraphNode, AspectDef } from '../../src/model/graph.js';
import type { LockVerification, VerifiedPair, PairState } from '../../src/core/verify-lock.js';
import type { CheckResult, CheckIssue } from '../../src/core/check.js';
import { nodeUnit } from '../../src/model/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The REAL repo root (real .yggdrasil/ graph + real source). tests/integration → cli → source → repo.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Per-node honest-state derivation, asserted on the REAL repo graph. buildPortalNodes
// is pure over the engine's own results (verifyLock pairs, runCheck issues, the effective-
// aspect cascade) — so the per-node state, effective-aspect rows, relations and log it
// emits can never diverge from what `yg check` / `yg context` would report.

describe('portal per-node derivation (honest state, effective aspects, relations, log)', () => {
  let byPath: Map<string, PortalNode>;

  beforeAll(async () => {
    const graph = await loadGraph(REPO_ROOT);
    const gitFiles = await walkRepoFiles(REPO_ROOT);
    const check = await runCheck(graph, gitFiles);
    const lock = readLock(graph.rootPath);
    const verification = await verifyLock(graph, lock);

    const logContents = new Map<string, string>();
    for (const nodePath of graph.nodes.keys()) {
      logContents.set(nodePath, await readLogContent(REPO_ROOT, nodePath));
    }
    const suppressions: SuppressionsByFile = { byFile: new Map() };

    const nodes = buildPortalNodes(graph, lock, verification, check, logContents, suppressions);
    byPath = new Map(nodes.map((n) => [n.path, n]));
  }, 180_000);

  it('cli/core/fill is checked, carries the advisory high-fan-out warning state', () => {
    const fill = byPath.get('cli/core/fill');
    expect(fill).toBeDefined();
    expect(fill!.checked).toBe(true);
    // The high-fan-out advisory issue promotes an otherwise-verified node to `warning`.
    expect(fill!.state).toBe('warning');
  });

  it('cli/core/fill effective aspects include a deterministic row with channel + origin + pairState', () => {
    const fill = byPath.get('cli/core/fill')!;
    expect(fill.effectiveAspects.length).toBeGreaterThan(0);
    const det = fill.effectiveAspects.find((a) => a.kind === 'deterministic');
    expect(det).toBeDefined();
    // channel is the attach provenance (1=own, 3=type, etc.) — a real number 1..7.
    expect(typeof det!.channel).toBe('number');
    expect(det!.channel).toBeGreaterThanOrEqual(1);
    expect(det!.channel).toBeLessThanOrEqual(7);
    // origin is the machine-readable provenance token (e.g. `type:engine`, `own:...`).
    expect(det!.origin.length).toBeGreaterThan(0);
    // deterministic aspects are free; the real lock is all-green → verified.
    expect(det!.cost).toBe('free');
    expect(det!.pairState).toBe('verified');
  });

  it('an LLM effective aspect carries tier + consensus + billed cost', () => {
    const fill = byPath.get('cli/core/fill')!;
    const llm = fill.effectiveAspects.find((a) => a.kind === 'llm');
    expect(llm).toBeDefined();
    expect(llm!.cost).toBe('billed');
    expect(typeof llm!.tier).toBe('string');
    expect(typeof llm!.consensus).toBe('number');
  });

  it('a no-rule node (scripts) has checked=false, state=no-rule, empty effective aspects', () => {
    const scripts = byPath.get('scripts');
    expect(scripts).toBeDefined();
    expect(scripts!.checked).toBe(false);
    expect(scripts!.state).toBe('no-rule');
    expect(scripts!.effectiveAspects).toEqual([]);
    // own state and rollupState are kept SEPARATE: a no-rule node owns no rule, but its
    // rollupState reflects the worst of itself and any descendants (here: still no-rule).
    expect(scripts!.rollupState).toBe('no-rule');
  });

  it('relationsOut mirrors declared relations and relationsIn is the inversion', () => {
    // cli/portal/pipeline declares calls/uses to several engine nodes (see its yg-node.yaml).
    const pipeline = byPath.get('cli/portal/pipeline')!;
    expect(pipeline.relationsOut.length).toBeGreaterThan(0);
    const usesContract = pipeline.relationsOut.find((r) => r.target === 'cli/portal/contract');
    expect(usesContract).toBeDefined();
    expect(usesContract!.type).toBe('uses');
    // The contract node must see the pipeline as an inbound relation.
    const contract = byPath.get('cli/portal/contract')!;
    const inbound = contract.relationsIn.find((r) => r.source === 'cli/portal/pipeline');
    expect(inbound).toBeDefined();
    expect(inbound!.type).toBe('uses');
  });

  it('rollupState bubbles a child warning up to an ancestor without mutating own state', () => {
    // cli/core is the parent of cli/core/fill (which is `warning`). cli/core's OWN state
    // need not be warning, but its rollup must be at least `warning`.
    const core = byPath.get('cli/core');
    if (core) {
      const rank: Record<string, number> = { 'no-rule': 0, verified: 1, warning: 2, unverified: 3, refused: 4 };
      expect(rank[core.rollupState]).toBeGreaterThanOrEqual(rank['warning']);
    }
  });
});

// ── Synthetic branch coverage: the honest states the all-green real lock never reaches ──
//
// The real repo lock is all-verified, so the refused / unverified / gate-state arms of
// the per-node derivation are exercised here by driving the REAL buildPortalNodes with a
// minimal synthetic graph + a hand-built verification result. No fabricated PortalData —
// only minimal real inputs that reach each honest branch (mirrors the buildCounts
// synthetic block in portal-extract.test.ts).

function aspectDef(id: string, kind: 'llm' | 'deterministic' | 'aggregate', status: AspectDef['status'] = 'enforced'): AspectDef {
  const reviewer = kind === 'aggregate' ? { type: 'aggregate' } : { type: kind };
  return {
    name: id,
    id,
    reviewer,
    artifacts: [],
    status,
    ...(kind === 'aggregate' ? { implies: ['child'] } : {}),
  } as unknown as AspectDef;
}

function node(path: string, type: string, aspects: string[], mapping: string[], children: GraphNode[] = []): GraphNode {
  return {
    path,
    meta: { name: path, type, aspects, mapping },
    children,
    parent: null,
  } as unknown as GraphNode;
}

function vp(aspectId: string, nodePath: string, state: PairState, kind: 'llm' | 'deterministic' = 'deterministic'): VerifiedPair {
  return {
    pair: { aspectId, kind, unitKey: nodeUnit(nodePath), nodePath, status: 'enforced', subjectFiles: ['f.ts'] },
    state,
  };
}

function syntheticCheck(issues: Partial<CheckIssue>[]): CheckResult {
  return { issues } as unknown as CheckResult;
}

describe('per-node derivation — honest states on synthetic inputs', () => {
  it('a refused pair drives state=refused; an unverified/gate pair drives state=unverified', () => {
    const aRef = aspectDef('a-ref', 'deterministic');
    const aUnv = aspectDef('a-unv', 'deterministic');
    const aGate = aspectDef('a-gate', 'llm');
    const refused = node('ref', 'module', ['a-ref'], ['f.ts']);
    const unver = node('unv', 'module', ['a-unv'], ['f.ts']);
    const gate = node('gate', 'module', ['a-gate'], ['f.ts']);
    const graph = {
      nodes: new Map([['ref', refused], ['unv', unver], ['gate', gate]]),
      aspects: [aRef, aUnv, aGate],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = {
      pairs: [
        vp('a-ref', 'ref', { kind: 'refused', reason: 'no' }),
        vp('a-unv', 'unv', { kind: 'unverified' }),
        // a prompt-too-large gate state must collapse to unverified (never green, never a "no").
        vp('a-gate', 'gate', { kind: 'prompt-too-large', chars: 9, limit: 4, tierName: 't' }, 'llm'),
      ],
      unreadable: [],
    };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    expect(out.get('ref')!.state).toBe('refused');
    expect(out.get('ref')!.effectiveAspects[0].pairState).toBe('refused');
    expect(out.get('unv')!.state).toBe('unverified');
    expect(out.get('gate')!.state).toBe('unverified'); // gate state collapses
  });

  it('rollupState bubbles a refused child to a no-rule parent without changing the parent own state', () => {
    const aRef = aspectDef('a-ref', 'deterministic');
    const child = node('p/c', 'module', ['a-ref'], ['f.ts']);
    const parent = node('p', 'module', [], [], [child]);
    child.parent = parent;
    const graph = {
      nodes: new Map([['p', parent], ['p/c', child]]),
      aspects: [aRef],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a-ref', 'p/c', { kind: 'refused' })], unreadable: [] };
    const out = new Map(
      buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() }).map((n) => [n.path, n]),
    );
    expect(out.get('p')!.state).toBe('no-rule'); // parent owns no rule
    expect(out.get('p')!.rollupState).toBe('refused'); // but its subtree is refused
  });

  it('per-node suppressions are filtered to the node mapped files; the log is parsed', () => {
    const aDet = aspectDef('a', 'deterministic');
    const n = node('n', 'module', ['a'], ['src/x.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [aDet], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const verification: LockVerification = { pairs: [vp('a', 'n', { kind: 'verified' })], unreadable: [] };
    const supp: PortalSuppression = { aspectId: 'a', file: 'src/x.ts', line: 3, reason: 'ok' };
    const byFile = new Map<string, PortalSuppression[]>([['src/x.ts', [supp]], ['other.ts', [{ ...supp, file: 'other.ts' }]]]);
    const logs = new Map([['n', '## [2026-01-01T00:00:00.000Z]\nbody text\n']]);
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), logs, { byFile });
    const portal = out.find((x) => x.path === 'n')!;
    expect(portal.suppressions).toHaveLength(1); // only the node's own file
    expect(portal.suppressions[0].file).toBe('src/x.ts');
    expect(portal.log).toHaveLength(1);
    expect(portal.log[0].body).toContain('body text');
  });

  it('an aggregate effective aspect yields an aggregate row with pairState n/a', () => {
    const agg = aspectDef('agg', 'aggregate');
    const child = aspectDef('child', 'deterministic');
    const n = node('n', 'module', ['agg'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [agg, child], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    // child gets a verified pair; agg has no pair (no own verdict).
    const verification: LockVerification = { pairs: [vp('child', 'n', { kind: 'verified' })], unreadable: [] };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    const aggRow = portal.effectiveAspects.find((a) => a.aspectId === 'agg')!;
    expect(aggRow.kind).toBe('aggregate');
    expect(aggRow.pairState).toBe('n/a');
    expect(aggRow.cost).toBe('free');
  });
});

describe('per-node derivation — notApplicable + implied-channel origin (synthetic)', () => {
  it('an aspect attached but filtered out by a when predicate appears in notApplicable', () => {
    // own aspect a-when carries a global when that never holds (a path atom on a node
    // with no matching mapping) → attached (own declaration) yet not effective.
    const aWhen = {
      name: 'a-when',
      id: 'a-when',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      status: 'enforced',
      when: { node: { type: 'some-other-type' } },
    } as unknown as AspectDef;
    const n = node('n', 'module', ['a-when'], ['src/real.ts']);
    const graph = {
      nodes: new Map([['n', n]]),
      aspects: [aWhen],
      flows: [],
      architecture: { node_types: {} },
    } as unknown as Graph;
    const verification: LockVerification = { pairs: [], unreadable: [] };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    expect(portal.notApplicable.map((x) => x.aspectId)).toContain('a-when');
    expect(portal.effectiveAspects.find((a) => a.aspectId === 'a-when')).toBeUndefined();
    // No effective non-draft aspect remains → the node is no-rule.
    expect(portal.checked).toBe(false);
    expect(portal.state).toBe('no-rule');
  });

  it('an aspect reaching a node via implies carries channel 7 with an implied origin', () => {
    const parent = {
      name: 'parent', id: 'parent', reviewer: { type: 'deterministic' }, artifacts: [], status: 'enforced', implies: ['kid'],
    } as unknown as AspectDef;
    const kid = { name: 'kid', id: 'kid', reviewer: { type: 'deterministic' }, artifacts: [], status: 'enforced' } as unknown as AspectDef;
    const n = node('n', 'module', ['parent'], ['f.ts']);
    const graph = { nodes: new Map([['n', n]]), aspects: [parent, kid], flows: [], architecture: { node_types: {} } } as unknown as Graph;
    const verification: LockVerification = {
      pairs: [vp('parent', 'n', { kind: 'verified' }), vp('kid', 'n', { kind: 'verified' })],
      unreadable: [],
    };
    const out = buildPortalNodes(graph, {} as never, verification, syntheticCheck([]), new Map(), { byFile: new Map() });
    const portal = out.find((x) => x.path === 'n')!;
    const kidRow = portal.effectiveAspects.find((a) => a.aspectId === 'kid')!;
    expect(kidRow.channel).toBe(7); // reached only via implies
    expect(kidRow.origin).toBe('implied:parent');
  });
});
