import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift } from '../../../src/core/check.js';
import { approveNode } from '../../../src/core/approve.js';
import { selectDriftedAspects } from '../../../src/core/approve-cascade-select.js';
import { buildAspectVerdicts, applyAspectVerdictsToResult } from '../../../src/core/approve-verdicts.js';
import { yggPrefixOf } from '../../../src/core/graph/files.js';
import { recordBaselineForAllMappedNodes, commitApprovedBaseline } from '../helpers/seed-baseline.js';
import { readNodeDriftState } from '../../../src/io/drift-state-store.js';
import type { AspectVerificationResult } from '../../../src/model/drift.js';

// ===========================================================================
// BOUNTY 4 — drift-and-cascade SPEC conformance.
//
// SPEC: `yg knowledge read drift-and-cascade`. Each test below pins ONE concrete,
// testable invariant the spec documents and confronts the real code against it.
// The spec, NOT the code, is the authority.
//
// Invariants under test (paraphrased + their spec home):
//   I1  Source drift = mapped-file content edit ("Any modification (even
//       whitespace)"). § Source drift.
//   I2  A SOURCE change is node-global: every effective non-draft aspect
//       re-runs. § Cost ("A SOURCE change is node-global"). Encoded by
//       selectDriftedAspects ⇒ undefined.
//   I3  An aspect-only cascade re-runs JUST that one aspect; the node's other
//       aspects keep their prior verdict (no LLM call). § Cost. Encoded by
//       selectDriftedAspects ⇒ { changedAspect } and verdict carry-forward.
//   I4  Editing an aspect's content.md is upstream drift cascading to EVERY
//       effective node (one entry per node). § Upstream drift.
//   I5  Editing a reference file declared in `references:` is the SAME cascade
//       as a content.md change. § Upstream drift (reference drift).
//   I6  A parent's aspect change cascades to descendants (upstream). § Upstream.
//   I7  A cosmetic flow edit (description only) does NOT cascade; an aspect-set
//       or participant-set change DOES. § Upstream drift / flow.
//   I8  Deterministic re-verify costs ZERO LLM (no reviewer configured, all
//       deterministic ⇒ approve still succeeds). § Cost.
//   I9  Infrastructure failure stays RED: NO reviewer configured for an
//       effective non-draft LLM aspect ⇒ refuse, write NOTHING, prior baseline
//       intact. § Per-node independent execution (fail-closed).
//   I10 Status is NOT part of the canonical drift hash: advisory↔enforced flip
//       does not drift. § Status and drift.
//   I11 A hand-edited verdict (refused→approved) changes the recomputed hash ⇒
//       baseline-integrity error. § What the baseline records.
//   I12 draft → non-draft surfaces as aspect-newly-active (missing baseline). §
//       Status and drift.
//   I13 The batch modes (--node / --aspect / --flow) behave as documented, and
//       a deterministic --aspect / --flow cascade clears at zero LLM cost. §
//       Batch approve.
//   I14 One node's failure does NOT abort the others; exit 1 if ANY failed. §
//       Per-node independent execution.
//
// Hermetic: every unit test builds a graph in a fresh mkdtemp tree, seeds a
// production-shaped baseline (no reviewer call), and rm's the tree in afterEach.
// The E2E cases spawn the binary against a copy of the e2e-lifecycle fixture
// with the single LLM aspect stripped (deterministic-only) so no LLM is ever
// contacted; the few LLM-path cases point the reviewer at a dead loopback.
// ===========================================================================

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function freshProject(configYaml = 'version: "5.0.0"\n'): Promise<{ dir: string; ygg: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-bounty4-'));
  tmpDirs.push(dir);
  const ygg = path.join(dir, '.yggdrasil');
  await mkdir(path.join(ygg, 'schemas'), { recursive: true });
  await mkdir(path.join(ygg, '.drift-state'), { recursive: true });
  await writeFile(path.join(ygg, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(ygg, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(ygg, 'yg-config.yaml'), configYaml);
  return { dir, ygg };
}

async function writeNode(ygg: string, nodePath: string, yaml: string): Promise<void> {
  const nodeDir = path.join(ygg, 'model', nodePath);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), yaml);
}

async function writeLlmAspect(ygg: string, id: string, opts: { status?: string; references?: string[] } = {}): Promise<void> {
  const aspDir = path.join(ygg, 'aspects', id);
  await mkdir(aspDir, { recursive: true });
  const refBlock = opts.references
    ? `references:\n${opts.references.map((p) => `  - path: ${p}\n`).join('')}`
    : '';
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: llm\n${opts.status ? `status: ${opts.status}\n` : ''}${refBlock}`,
  );
  await writeFile(path.join(aspDir, 'content.md'), `Rule for ${id}.\n`);
}

async function writeDetAspect(ygg: string, id: string, opts: { status?: string } = {}): Promise<void> {
  const aspDir = path.join(ygg, 'aspects', id);
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    `name: ${id}\ndescription: ${id} rule\nreviewer:\n  type: deterministic\n${opts.status ? `status: ${opts.status}\n` : ''}`,
  );
  await writeFile(path.join(aspDir, 'check.mjs'), 'export function check(ctx) { return []; }\n');
}

async function writeFlow(ygg: string, name: string, yaml: string): Promise<void> {
  const flowDir = path.join(ygg, 'flows', name);
  await mkdir(flowDir, { recursive: true });
  await writeFile(path.join(flowDir, 'yg-flow.yaml'), yaml);
}

async function writeSrc(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const issuesFor = (issues: Awaited<ReturnType<typeof classifyDrift>>, nodePath: string) =>
  issues.filter((i) => i.nodePath === nodePath);

// ===========================================================================
// SECTION I1 / I4 — source drift vs upstream drift detection.
// ===========================================================================

describe('drift detection: source vs upstream (spec §"Source drift", §"Upstream drift")', () => {
  it('I1: any modification of a mapped file — even whitespace — is source-drift', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Spec: "Any modification (even whitespace) causes drift." Add a trailing space.
    await writeSrc(dir, 'src/a.ts', 'export const a = 1; \n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    expect(issues.some((i) => i.code === 'source-drift')).toBe(true);
    expect(issues.some((i) => i.code === 'upstream-drift')).toBe(false);
  });

  it('I4: editing an aspect content.md is upstream drift on EVERY effective node (one per node)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    for (const n of ['a', 'b', 'c']) {
      await writeNode(ygg, `svc/${n}`, `name: ${n}\ntype: service\ndescription: x\naspects:\n  - shared\nmapping:\n  - src/${n}.ts\n`);
      await writeSrc(dir, `src/${n}.ts`, `export const ${n} = 1;\n`);
    }
    await writeLlmAspect(ygg, 'shared');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    await writeFile(path.join(ygg, 'aspects', 'shared', 'content.md'), 'Updated rule for shared.\n');
    const issues = await classifyDrift(await loadGraph(dir));
    for (const n of ['svc/a', 'svc/b', 'svc/c']) {
      const ups = issuesFor(issues, n).filter((i) => i.code === 'upstream-drift');
      expect(ups, `node ${n} must have exactly one collapsed upstream-drift`).toHaveLength(1);
      expect(ups[0].cascadeCauses!.some((c) => c.layer === 'aspects')).toBe(true);
      expect(issuesFor(issues, n).some((i) => i.code === 'source-drift')).toBe(false);
    }
  });

  it('I5: editing a declared reference file cascades exactly like a content.md change', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - refrule\nmapping:\n  - src/a.ts\n');
    await writeSrc(dir, 'docs/codes.md', 'CODE_A = 1\n');
    await writeLlmAspect(ygg, 'refrule', { references: ['docs/codes.md'] });
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Spec (reference drift): "A reference file declared in an aspect's references:
    // is modified — same cascade as content.md change."
    await writeSrc(dir, 'docs/codes.md', 'CODE_A = 2\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    const ups = issues.filter((i) => i.code === 'upstream-drift');
    expect(ups).toHaveLength(1);
    expect(issues.some((i) => i.code === 'source-drift')).toBe(false);
  });

  it('I6: a parent node aspect change cascades to descendants on the hierarchy layer', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\naspects:\n  - parentasp\n');
    await writeNode(ygg, 'svc/a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'parentasp');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\naspects:\n  - parentasp\n  - own\n');
    const ups = issuesFor(await classifyDrift(await loadGraph(dir)), 'svc/a').filter((i) => i.code === 'upstream-drift');
    expect(ups).toHaveLength(1);
    expect(ups[0].cascadeCauses!.some((c) => c.layer === 'hierarchy')).toBe(true);
  });
});

// ===========================================================================
// SECTION I7 — flow cascade: cosmetic vs effective-set change.
// ===========================================================================

describe('flow cascade (spec: cosmetic description edit does NOT cascade)', () => {
  it('I7a: a description-only flow edit produces NO drift', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - flowed\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'flowed');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: original\nnodes:\n  - a\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    await writeFlow(ygg, 'f1', 'name: F1\ndescription: COMPLETELY rewritten cosmetic prose\nnodes:\n  - a\naspects:\n  - flowed\n');
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);
  });

  it('I7b: adding a flow aspect DOES cascade to participants', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - a\naspects:\n  - flowed\n');
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    expect(issues.some((i) => i.code === 'aspect-newly-active' && i.aspectId === 'flowed')).toBe(true);
    expect(issues.some((i) => i.code === 'upstream-drift')).toBe(true);
  });

  it('I7c: adding a flow participant cascades to the new node only', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'svc', 'name: Svc\ntype: service\ndescription: parent\n');
    for (const n of ['a', 'b']) {
      await writeNode(ygg, `svc/${n}`, `name: ${n}\ntype: service\ndescription: x\naspects:\n  - own\nmapping:\n  - src/${n}.ts\n`);
      await writeSrc(dir, `src/${n}.ts`, `export const ${n} = 1;\n`);
    }
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'flowed');
    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\naspects:\n  - flowed\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    await writeFlow(ygg, 'f1', 'name: F1\ndescription: d\nnodes:\n  - svc/a\n  - svc/b\naspects:\n  - flowed\n');
    const issues = await classifyDrift(await loadGraph(dir));
    expect(issuesFor(issues, 'svc/b').some((i) => i.code === 'aspect-newly-active')).toBe(true);
    // svc/a's effective set is unchanged — no drift.
    expect(issuesFor(issues, 'svc/a')).toHaveLength(0);
  });
});

// ===========================================================================
// SECTION I2 / I3 — the COST model: source = node-global; aspect-only cascade
// re-runs just the changed aspect (selectDriftedAspects + verdict carry-forward).
// ===========================================================================

describe('cost model: re-verification scope (spec §Cost)', () => {
  it('I2: a SOURCE change forces a node-global re-run (selectDriftedAspects ⇒ undefined)', async () => {
    const { dir, ygg } = await freshProject();
    // log_required:false so approveNode computes changes without demanding a log
    // entry — this test exercises the change-classification, not the log gate.
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n    log_required: false\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - one\n  - two\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'one');
    await writeLlmAspect(ygg, 'two');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    const graph0 = await loadGraph(dir);
    await recordBaselineForAllMappedNodes(graph0);

    // Edit the source file → approveNode reports a source change.
    await writeSrc(dir, 'src/a.ts', 'export const a = 2;\n');
    const graph = await loadGraph(dir);
    const stored = await readNodeDriftState(graph.rootPath, 'a');
    const result = await approveNode(graph, 'a');
    expect(result.changedSource && result.changedSource.length > 0).toBe(true);

    const subset = selectDriftedAspects(graph, 'a', result, stored ?? undefined, yggPrefixOf(graph));
    // Spec: a SOURCE change is node-global → re-run ALL aspects (undefined sentinel).
    expect(subset).toBeUndefined();
  });

  it('I3: an aspect-only cascade re-runs JUST the changed aspect; others carry forward', async () => {
    const { dir, ygg } = await freshProject();
    // A pure aspect-content change is NOT a source change, so the mandatory-log
    // gate never fires here even with log_required:true; but keep the config
    // explicit and uniform with I2.
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n    log_required: false\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - one\n  - two\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'one');
    await writeLlmAspect(ygg, 'two');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));

    // Change ONLY aspect 'one' content — no source edit.
    await writeFile(path.join(ygg, 'aspects', 'one', 'content.md'), 'Updated rule for one.\n');
    const graph = await loadGraph(dir);
    const stored = await readNodeDriftState(graph.rootPath, 'a');
    const result = await approveNode(graph, 'a');
    expect(result.changedSource ?? []).toHaveLength(0);

    const subset = selectDriftedAspects(graph, 'a', result, stored ?? undefined, yggPrefixOf(graph));
    // Spec: aspect-only cascade re-runs just that one aspect.
    expect(subset).toBeDefined();
    expect([...subset!]).toEqual(['one']);
    // 'two' is NOT re-run → its prior verdict carries forward (no LLM call for it).
    expect(subset!.has('two')).toBe(false);
  });

  it('I3b: verdict carry-forward — a full-node re-run with one un-evaluated aspect keeps its prior verdict', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - one\n  - two\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'one');
    await writeLlmAspect(ygg, 'two');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    const graph = await loadGraph(dir);
    const node = graph.nodes.get('a')!;

    // Reviewer evaluated ONLY 'one' this run (e.g. a per-aspect re-run); 'two' has
    // no fresh result → its prior baseline verdict must carry forward.
    const allResults: Record<string, AspectVerificationResult> = {
      one: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, allResults);
    expect(carryForward).toContain('two'); // no result this run → carry forward
    expect(verdicts.one).toEqual({ verdict: 'approved' });

    // Apply onto a result with a prior baseline where 'two' was approved.
    const result = {
      action: 'approved' as const,
      currentHash: '',
      pendingDriftState: {
        nodePath: 'a',
        state: {
          schemaVersion: 1 as const,
          hash: '',
          files: {},
          identity: { ownSubset: '', ports: {}, aspects: {} },
          aspectVerdicts: {},
        },
      },
    };
    applyAspectVerdictsToResult(
      result,
      verdicts,
      carryForward,
      { one: { verdict: 'approved' }, two: { verdict: 'approved' } },
      undefined,
      false,
    );
    // Spec §Cost: "the node's other aspects keep their prior verdict (no LLM call)."
    expect((result.pendingDriftState!.state.aspectVerdicts as Record<string, { verdict: string }>).two).toEqual({ verdict: 'approved' });
    expect((result.pendingDriftState!.state.aspectVerdicts as Record<string, { verdict: string }>).one).toEqual({ verdict: 'approved' });
  });
});

// ===========================================================================
// SECTION I10 / I12 — status semantics in the canonical drift hash.
// ===========================================================================

describe('status and the canonical hash (spec §"Status and drift")', () => {
  it('I10: advisory↔enforced flip is NOT drift (hash stable, verdict carries forward)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - rule\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'rule', { status: 'advisory' });
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Flip advisory → enforced. Spec: "The hash is stable across advisory↔enforced
    // flips." So no source-drift / upstream-drift / aspect-newly-active.
    await writeLlmAspect(ygg, 'rule', { status: 'enforced' });
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    expect(issues.some((i) => i.code === 'source-drift')).toBe(false);
    expect(issues.some((i) => i.code === 'upstream-drift')).toBe(false);
    expect(issues.some((i) => i.code === 'aspect-newly-active')).toBe(false);
  });

  it('I12: draft → enforced surfaces as aspect-newly-active (missing baseline)', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - own\n  - wip\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'own');
    await writeLlmAspect(ygg, 'wip', { status: 'draft' });
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Flip wip draft → enforced. Spec: "draft → advisory/enforced → drift emitted
    // as aspect-newly-active (missing baseline)."
    await writeLlmAspect(ygg, 'wip', { status: 'enforced' });
    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    expect(issues.some((i) => i.code === 'aspect-newly-active' && i.aspectId === 'wip')).toBe(true);
  });
});

// ===========================================================================
// SECTION I11 — baseline integrity: a tampered verdict re-keys the hash.
// ===========================================================================

describe('baseline integrity (spec §"What the baseline records")', () => {
  it('I11: hand-editing a stored verdict (refused→approved) trips baseline-integrity', async () => {
    const { dir, ygg } = await freshProject();
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - rule\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'rule');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');
    await recordBaselineForAllMappedNodes(await loadGraph(dir));
    expect(await classifyDrift(await loadGraph(dir))).toHaveLength(0);

    // Tamper: flip the stored verdict to a DIFFERENT value WITHOUT recomputing
    // the canonical hash. Spec: the canonical hash is computed over the verdict
    // map too, so this divergence must surface as baseline-integrity.
    const statePath = path.join(ygg, '.drift-state', 'a.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.aspectVerdicts.rule = { verdict: 'refused', reason: 'tampered' };
    await writeFile(statePath, JSON.stringify(state));

    const issues = issuesFor(await classifyDrift(await loadGraph(dir)), 'a');
    expect(issues.some((i) => i.code === 'baseline-integrity')).toBe(true);
  });
});

// ===========================================================================
// SECTION I8 — deterministic re-verify is ZERO LLM (no reviewer configured at
// all, every aspect deterministic ⇒ approve still succeeds & records a baseline).
//
// This drives the REAL reviewer dispatch (runApproveWithReviewer) with NO
// graph.config.reviewer. A deterministic aspect runs locally; an LLM aspect in
// that situation would fail closed (see I9). Proving approve succeeds with no
// reviewer object confirms ZERO LLM calls were needed.
// ===========================================================================

describe('deterministic re-verify costs zero LLM (spec §Cost)', () => {
  it('I8: a deterministic-only node approves with NO reviewer configured', async () => {
    const { dir, ygg } = await freshProject();
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n    log_required: false\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - det\nmapping:\n  - src/a.ts\n');
    await writeDetAspect(ygg, 'det');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');

    const graph = await loadGraph(dir);
    // graph.config has no `reviewer` block (config yaml omits it).
    expect(graph.config.reviewer).toBeUndefined();
    const core = await approveNode(graph, 'a');
    const { runApproveWithReviewer } = await import('../../../src/core/approve-reviewer.js');
    const stored = await readNodeDriftState(graph.rootPath, 'a');
    const res = await runApproveWithReviewer({
      graph,
      nodePath: 'a',
      result: core,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: stored ?? undefined,
    });
    // Spec: "a node whose aspects are all deterministic re-approves with no LLM call."
    expect(res.action).not.toBe('refused');
    expect(res.llmSkipped).toBeUndefined();
    // Baseline was committed (a real baseline exists now).
    const after = await readNodeDriftState(graph.rootPath, 'a');
    expect(after).not.toBeNull();
  });
});

// ===========================================================================
// SECTION I9 — fail-closed: no reviewer configured for an effective non-draft
// LLM aspect ⇒ refuse and write NOTHING (prior baseline intact).
// ===========================================================================

describe('infrastructure failure stays red (spec §"Per-node independent execution")', () => {
  it('I9: no reviewer + an effective non-draft LLM aspect ⇒ refuse, commit nothing, prior baseline intact', async () => {
    const { dir, ygg } = await freshProject();
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  service:\n    description: s\n    log_required: false\n');
    await writeNode(ygg, 'a', 'name: A\ntype: service\ndescription: x\naspects:\n  - rule\nmapping:\n  - src/a.ts\n');
    await writeLlmAspect(ygg, 'rule');
    await writeSrc(dir, 'src/a.ts', 'export const a = 1;\n');

    // Seed a known-good prior baseline (one where the verdict is approved).
    const graph0 = await loadGraph(dir);
    const seed = await approveNode(graph0, 'a');
    await commitApprovedBaseline(graph0, 'a', graph0.rootPath, seed);
    const priorState = await readNodeDriftState(graph0.rootPath, 'a');
    expect(priorState).not.toBeNull();
    const priorRaw = await readFile(path.join(ygg, '.drift-state', 'a.json'), 'utf-8');

    // Now force a re-approve with NO reviewer configured. The LLM aspect cannot be
    // verified → fail closed.
    await writeSrc(dir, 'src/a.ts', 'export const a = 2;\n');
    const graph = await loadGraph(dir);
    expect(graph.config.reviewer).toBeUndefined();
    const core = await approveNode(graph, 'a');
    const { runApproveWithReviewer } = await import('../../../src/core/approve-reviewer.js');
    const res = await runApproveWithReviewer({
      graph,
      nodePath: 'a',
      result: core,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: priorState ?? undefined,
    });
    // Spec: approve exits 1 and writes NOTHING; prior baseline fully intact.
    expect(res.action).toBe('refused');
    expect(res.llmSkipped).toBe('unavailable');
    const afterRaw = await readFile(path.join(ygg, '.drift-state', 'a.json'), 'utf-8');
    expect(afterRaw).toBe(priorRaw); // baseline byte-for-byte unchanged
  });
});

// ===========================================================================
// SECTION I13 / I14 — E2E batch modes against the binary, fully deterministic.
//
// The e2e-lifecycle fixture's only LLM aspect is `has-doc-comment`; we strip it
// so every effective aspect is deterministic (no-todo-comments enforced,
// requires-named-export advisory, wip-rule draft). With every aspect
// deterministic, the binary never contacts an LLM — proving the documented
// "ZERO LLM cost" claim for deterministic cascades.
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function runCli(args: string[], cwd: string): { status: number | null; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Copy e2e-lifecycle, strip the lone LLM aspect, kill the reviewer endpoint. */
function deterministicFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-bounty4-e2e-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
  writeFileSync(
    archPath,
    readFileSync(archPath, 'utf-8').split('\n').filter((l) => l.trim() !== '- has-doc-comment').join('\n'),
    'utf-8',
  );
  rmSync(path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment'), { recursive: true, force: true });
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${DEAD_ENDPOINT}"`),
    'utf-8',
  );
  return dir;
}

describe.skipIf(!distExists)('E2E batch modes (spec §"Batch approve", §"Per-node independent execution")', () => {
  it('I13a: --node A --node B approves both independently (exit 0); check goes green', () => {
    const dir = deterministicFixture('node-batch');
    try {
      const r = runCli(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('services/orders');
      expect(r.all).toContain('services/payments');
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I13b: a SOURCE edit drifts the node; --node re-approve clears it (deterministic ⇒ zero LLM)', () => {
    const dir = deterministicFixture('source-edit');
    try {
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);

      // Edit the orders source file → source drift.
      const ordersSrc = path.join(dir, 'src', 'services', 'orders.ts');
      writeFileSync(ordersSrc, readFileSync(ordersSrc, 'utf-8') + '\nexport const extra = 1;\n', 'utf-8');
      const drifted = runCli(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('services/orders');

      // Re-approve clears it — no LLM endpoint is even reachable, proving zero-LLM.
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I13c: --aspect cascade re-approves every drifted node at zero LLM cost', () => {
    const dir = deterministicFixture('aspect-cascade');
    try {
      // Settle clean baselines for both flow participants.
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);

      // Edit the shared deterministic aspect's check.mjs → upstream cascade to
      // every node carrying it (both services via the type default).
      const checkPath = path.join(dir, '.yggdrasil', 'aspects', 'no-todo-comments', 'check.mjs');
      writeFileSync(checkPath, readFileSync(checkPath, 'utf-8') + '\n// cascade trigger comment\n', 'utf-8');
      const drifted = runCli(['check'], dir);
      expect(drifted.status).toBe(1);
      // The cascade names the changed aspect and both participants (the reporter
      // collapses sibling node paths into a `services/{orders, payments}` brace
      // group), and points at the documented `--aspect` clear.
      expect(drifted.all).toContain("aspect 'no-todo-comments' check.mjs changed");
      expect(drifted.all).toContain('orders');
      expect(drifted.all).toContain('payments');
      expect(drifted.all).toContain('yg approve --aspect no-todo-comments');

      // The deterministic --aspect batch clears it (zero LLM — endpoint is dead).
      const reapprove = runCli(['approve', '--aspect', 'no-todo-comments'], dir);
      expect(reapprove.status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I13d: --flow cascade re-approves participants when a flow aspect is added (zero LLM)', () => {
    const dir = deterministicFixture('flow-cascade');
    try {
      // Author a NEW deterministic aspect to attach via the flow.
      const aspDir = path.join(dir, '.yggdrasil', 'aspects', 'extra-det');
      mkdirSync(aspDir, { recursive: true });
      writeFileSync(
        path.join(aspDir, 'yg-aspect.yaml'),
        'name: ExtraDet\ndescription: extra deterministic rule via flow.\nreviewer:\n  type: deterministic\nstatus: enforced\n',
        'utf-8',
      );
      writeFileSync(path.join(aspDir, 'check.mjs'), 'export function check(ctx) { return []; }\n', 'utf-8');

      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);

      const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
      writeFileSync(
        flowPath,
        readFileSync(flowPath, 'utf-8').replace('aspects:\n  - no-todo-comments', 'aspects:\n  - no-todo-comments\n  - extra-det'),
        'utf-8',
      );
      const drifted = runCli(['check'], dir);
      expect(drifted.status).toBe(1);
      expect(drifted.all).toContain('services/orders');
      expect(drifted.all).toContain('services/payments');

      const reapprove = runCli(['approve', '--flow', 'order-processing'], dir);
      expect(reapprove.status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I13e: a cosmetic flow DESCRIPTION edit does NOT cascade (check stays green)', () => {
    const dir = deterministicFixture('flow-cosmetic');
    try {
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
      expect(runCli(['check'], dir).status).toBe(0);

      const flowPath = path.join(dir, '.yggdrasil', 'flows', 'order-processing', 'yg-flow.yaml');
      writeFileSync(
        flowPath,
        readFileSync(flowPath, 'utf-8').replace(
          /description:.*/,
          'description: A totally rewritten cosmetic description with new prose.',
        ),
        'utf-8',
      );
      // Spec: a cosmetic edit to the flow's description does NOT cascade.
      expect(runCli(['check'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I14: a batch where one node fails ⇒ exit 1, but the other node still approves', () => {
    const dir = deterministicFixture('batch-partial');
    try {
      expect(runCli(['approve', '--node', 'services/orders'], dir).status).toBe(0);
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);

      // Make orders violate the ENFORCED no-todo-comments aspect (a code refusal).
      const ordersSrc = path.join(dir, 'src', 'services', 'orders.ts');
      writeFileSync(ordersSrc, readFileSync(ordersSrc, 'utf-8') + '\n// TODO: fix this later\n', 'utf-8');
      // payments gets a clean source edit (will re-approve fine).
      const paymentsSrc = path.join(dir, 'src', 'services', 'payments.ts');
      writeFileSync(paymentsSrc, readFileSync(paymentsSrc, 'utf-8') + '\nexport const ok = 1;\n', 'utf-8');

      const batch = runCli(['approve', '--node', 'services/orders', '--node', 'services/payments'], dir);
      // Spec: exit 1 if ANY node failed; one node's failure does not abort the others.
      expect(batch.status).toBe(1);
      expect(batch.all).toContain('services/orders');
      expect(batch.all).toContain('services/payments');

      // payments approved despite orders' failure → it is now clean on its own.
      expect(runCli(['approve', '--node', 'services/payments'], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
