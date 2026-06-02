import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { runLlmVerification } from '../../../src/cli/approve.js';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-approve-llm-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), opts.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);
  // A log entry exists so the mandatory log gate (log_required + source change)
  // is satisfied. recordBaseline does not capture a log baseline, so this entry
  // counts as "fresh" for any subsequent source change — these tests exercise the
  // reviewer, not the log gate.
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');

  // Create parent nodes for nested paths (e.g. 'svc/my-service' needs 'svc' parent)
  const parts = opts.nodePath.split('/');
  if (parts.length > 1) {
    const parentPath = parts.slice(0, -1).join('/');
    const parentDir = path.join(yggRoot, 'model', parentPath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(
      path.join(parentDir, 'yg-node.yaml'),
      `name: ${parts[parts.length - 2]}\ntype: service\ndescription: parent\n`,
    );
  }

  if (opts.aspects) {
    for (const asp of opts.aspects) {
      const aspDir = path.join(yggRoot, 'aspects', asp.id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
      if (asp.files) {
        for (const [aName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, aName), content);
        }
      }
    }
  }

  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const abs = path.join(tmpDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  return { tmpDir, yggRoot };
}

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Option 1: reReviewAspectIds (per-aspect re-verification) ──
//
// On an approve where filterAspectId is undefined (--node, --flow cascade,
// parent-redirect), `reReviewAspectIds` restricts reviewer dispatch to the
// drifted subset. Every other effective non-draft aspect is carried forward
// from the prior baseline via the existing carryForward path — no reviewer
// call, prior verdict preserved.

describe('runApproveWithReviewer — reReviewAspectIds (Option 1)', () => {
  // Node with one deterministic structure aspect `det` and one llm aspect `llm`.
  // A prior baseline records both as approved. We drive an upstream-only change
  // (no source edit) so the node re-approves, then restrict dispatch to `det`.
  async function setup(name: string) {
    const { tmpDir } = await createTmpProject(name, {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
      ],
    });
    return tmpDir;
  }

  // Record a baseline that carries a prior verdict for BOTH aspects, then induce
  // upstream-only drift (touch the `det` aspect content) so approveNode produces
  // a pendingDriftState without any source change.
  async function recordBaselineWithVerdicts(tmpDir: string): Promise<void> {
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    const projectRoot = path.dirname(graph.rootPath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [], identity,
    );
    await writeNodeDriftState(graph.rootPath, 'svc/my-service', {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      identity,
      aspectVerdicts: {
        det: { verdict: 'approved' },
        llm: { verdict: 'approved' },
      },
    });
  }

  it('with reReviewAspectIds={det}: llm provider NOT called, llm verdict carried forward, det re-evaluated', async () => {
    const tmpDir = await setup('rereview-subset');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change — touch the det aspect's check.mjs (still passes).
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // No source change — upstream drift only.
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.pendingDriftState).toBeDefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      reReviewAspectIds: new Set(['det']),
    });

    expect(result.action).toBe('approved');
    // The LLM provider must NOT be called — only `det` was dispatched.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // `det` was re-evaluated this run.
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    // `llm` carried forward — committed verdict equals the prior baseline value.
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('with reReviewAspectIds=∅ (empty): NOTHING dispatched, full prior baseline preserved byte-for-byte', async () => {
    const tmpDir = await setup('rereview-empty');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change so approveNode still produces a pendingDriftState.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // No source change — upstream drift only.
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.pendingDriftState).toBeDefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      // Empty subset → filtered.length === 0 → reviewerAborted no-op path.
      reReviewAspectIds: new Set<string>(),
    });

    // Empty-subset no-op: no aspect dispatched at all.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // No reviewer landed a result — aspectResults stays absent/empty.
    expect(result.aspectResults).toBeUndefined();
    // The committed verdicts equal the FULL prior baseline, byte-for-byte: both
    // det and llm carried forward unchanged.
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed).toEqual({
      det: { verdict: 'approved' },
      llm: { verdict: 'approved' },
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('with reReviewAspectIds undefined: BOTH aspects dispatch (llm provider IS called)', async () => {
    const tmpDir = await setup('rereview-all');
    await recordBaselineWithVerdicts(tmpDir);
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      // reReviewAspectIds undefined → re-run all (today's behavior).
    });

    expect(result.action).toBe('approved');
    // The llm aspect IS dispatched → provider called exactly once.
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['llm']?.satisfied).toBe(true);
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('via runLlmVerification: an aspects/det/ upstream change attributes to det only — llm carried forward (yggPrefix threading)', async () => {
    const tmpDir = await setup('rereview-cli-layer');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change under .yggdrasil/aspects/det/ — must attribute to `det`.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // CLI layer computes yggPrefix internally and threads reReviewAspectIds.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // Only `det` drifted (attributable to aspects/det/), so the llm provider is
    // never called — proving the internal yggPrefix matches the changedUpstream paths.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('via runLlmVerification: a --aspect approve (filterAspectId set) bypasses the drift subset', async () => {
    const tmpDir = await setup('rereview-filteraspect');
    await recordBaselineWithVerdicts(tmpDir);
    // A change attributable to `det`; but the caller passes filterAspectId='llm'.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );
    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // filterAspectId='llm' takes priority: the det-attributable drift subset is NOT
    // computed (reReviewAspectIds suppressed), and only `llm` is dispatched.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map(), 'llm');

    expect(verifyCallCount).toBe(1); // llm ran via the filter, not the det subset
    expect(result.aspectResults?.['det']).toBeUndefined(); // det not re-run under --aspect=llm
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Option 1: end-to-end correctness invariants ──────────────
//
// These lock the composed behavior the unit tests (selectDriftedAspects,
// reReviewAspectIds dispatch) prove in isolation: a subset re-run must not
// weaken refusal (I4), a genuinely-changed aspect is never silently carried
// forward (I1), drafts are never dispatched (I3), the Phase-4 migration shape
// (an aspect yaml content change) re-runs only that aspect locally at zero LLM
// cost (cost win), and a genuine no-change run dispatches nothing while leaving
// the prior checkTouchedFiles byte-identical.

describe('runApproveWithReviewer — Option 1 end-to-end invariants', () => {
  // Node: structure aspect `det` + llm aspect `llm`. The llm aspect is wired so
  // we can make it refuse on demand by swapping the mock provider verdict.
  async function setupDetLlm(name: string, opts: { detRefuses?: boolean } = {}) {
    // The node maps a single FILE (not the directory). buildOwnFiles only
    // includes stat.isFile() mapping entries, so a file mapping makes
    // ctx.files non-empty. The refusing check below references ctx.files[0]
    // — a real file that IS in context — so the violation is a genuine
    // CODE violation, not a STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT infra error.
    const detCheck = opts.detRefuses
      ? `export function check(ctx) {
  const first = ctx.files[0];
  if (!first) throw new Error('det fixture invariant broken: ctx.files is empty (mapping must be a file, not a directory)');
  return [{ file: first.path, line: 1, message: 'structural violation' }];
}\n`
      : 'export function check(_ctx) { return []; }\n';
    const { tmpDir } = await createTmpProject(name, {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/index.ts\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n',
          files: { 'check.mjs': detCheck },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
      ],
    });
    return tmpDir;
  }

  async function recordVerdicts(
    tmpDir: string,
    aspectVerdicts: Record<string, { verdict: 'approved' | 'refused' }>,
    checkTouchedFiles?: Record<string, Record<string, string>>,
  ): Promise<void> {
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const projectRoot = path.dirname(graph.rootPath);
    // Compute the fresh identity, then inject any seeded checkTouched into it so
    // the recorded canonical hash includes the per-aspect read-set — exactly as a
    // real prior approve would have recorded it. Otherwise approveNode (which
    // recomputes WITH the baseline) would see a fresh read-set and mis-classify a
    // genuine no-change as upstream drift.
    const { trackedFiles, identity } = collectTrackedFiles(node, graph);
    for (const [aspectId, map] of Object.entries(checkTouchedFiles ?? {})) {
      if (identity.aspects[aspectId]) identity.aspects[aspectId].checkTouched = map;
    }
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [], identity,
    );
    // Capture the production-computed log baseline by running approveNode once
    // against this fresh project (no baseline yet → 'initial' with a populated
    // pendingDriftState.state.log). Recording it here makes logChanged false on
    // the subsequent no-change approve, so approveNode takes the branch that
    // clones the full prior baseline (including identity) rather than the
    // log-update branch.
    const initial = await approveNode(graph, 'svc/my-service');
    const log = initial.pendingDriftState?.state.log;
    await writeNodeDriftState(graph.rootPath, 'svc/my-service', {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      identity,
      ...(log ? { log } : {}),
      aspectVerdicts,
    });
  }

  // ── I4 — a genuine enforced CODE violation under a subset still refuses,
  //         records the refused verdict, and carries forward the other aspect ──
  it('I4: reReviewAspectIds={det} where det produces a genuine ENFORCED code violation → refused, det verdict persisted as refused, llm carried forward', async () => {
    // `det` (a structure aspect; default status enforced) maps a single FILE,
    // so ctx.files is non-empty and the check returns a violation against
    // ctx.files[0] — a real, in-context file. That makes it a genuine CODE
    // violation (errorSource: 'codeViolation'), NOT an infrastructure error.
    // We restrict dispatch to {det} only. The subset path must still refuse —
    // it must not weaken refusal — and the refused verdict is committed to the
    // baseline (the project records refused verdicts so yg check can render
    // them), while `llm` (not in the subset) is carried forward untouched.
    const tmpDir = await setupDetLlm('e2e-i4-refuse', { detRefuses: true });
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // Upstream-only change so approveNode produces a pendingDriftState w/o source edit.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/yg-aspect.yaml'),
      'name: Det\ndescription: structural shape (tweaked)\nreviewer:\n  type: deterministic\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedBefore = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: storedBefore,
      reReviewAspectIds: new Set(['det']),
    });

    // The subset path must NOT weaken refusal: an enforced structure violation refuses.
    expect(result.action).toBe('refused');
    // det refuses with a GENUINE code violation — not an infra/checkRuntime error.
    const detViolation = result.aspectViolations!.find(v => v.aspectId === 'det');
    expect(detViolation).toBeDefined();
    expect(detViolation!.errorSource).toBe('codeViolation');
    expect(detViolation!.reason).toContain('src/svc/index.ts');
    // The llm provider was never dispatched (only det in the subset).
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // The baseline IS written on the refusal path: det's refused verdict is
    // persisted (with its code-violation reason), and llm — not in the subset —
    // is carried forward from the prior baseline untouched.
    const storedAfter = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(storedAfter?.aspectVerdicts).toEqual({
      det: {
        verdict: 'refused',
        reason: 'src/svc/index.ts:1: structural violation',
        errorSource: 'codeViolation',
      },
      llm: { verdict: 'approved' },
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── I1 — a changed LLM aspect IS re-run (never silently carried forward) ──
  it('I1: an aspects/llm/ upstream change re-runs the llm aspect (provider called once), det carried forward', async () => {
    const tmpDir = await setupDetLlm('e2e-i1-llm-changed');
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // Upstream-only change under .yggdrasil/aspects/llm/ — must attribute to `llm`.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/llm/content.md'),
      'Code must be deterministic. (clarified)\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects runs for real and
    // computes reReviewAspectIds={llm} internally from result.changedUpstream.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // The genuinely-changed llm aspect IS dispatched — never silently carried forward.
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['llm']?.satisfied).toBe(true);
    // The structure aspect `det` was NOT re-evaluated this run (carried forward).
    expect(result.aspectResults?.['det']).toBeUndefined();
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── I3 — draft aspect never dispatched, prior verdict preserved ──
  it('I3: a draft aspect is never dispatched and its prior verdict is left untouched', async () => {
    const { tmpDir } = await createTmpProject('e2e-i3-draft', {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\n  - drafty\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
        {
          id: 'drafty',
          yaml: 'name: Drafty\ndescription: work in progress\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Some draft rule.\n' },
        },
      ],
    });
    // Prior baseline carries a verdict for the (now-draft) aspect too — it must
    // be left untouched, then evicted by the draft cleanup (not by a reviewer).
    const graph0 = await loadGraph(tmpDir);
    const node0 = graph0.nodes.get('svc/my-service')!;
    const { trackedFiles: trackedFiles0, identity: identity0 } = collectTrackedFiles(node0, graph0);
    const projectRoot0 = path.dirname(graph0.rootPath);
    const h0 = await hashTrackedFiles(projectRoot0, trackedFiles0, undefined, [], identity0);
    await writeNodeDriftState(graph0.rootPath, 'svc/my-service', {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: h0.canonicalHash,
      files: h0.fileHashes,
      mtimes: h0.fileMtimes,
      identity: identity0,
      aspectVerdicts: {
        det: { verdict: 'approved' },
        llm: { verdict: 'approved' },
        drafty: { verdict: 'approved' },
      },
    });
    // Upstream-only change under aspects/det/ so the subset is {det}.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      reReviewAspectIds: new Set(['det']),
    });

    expect(result.action).toBe('approved');
    // The draft aspect was never dispatched to any reviewer.
    expect(result.aspectResults?.['drafty']).toBeUndefined();
    // The non-draft llm aspect was carried forward (subset = {det}), so the
    // provider was never called either.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // The draft aspect was skipped — listed in skippedDraftAspects.
    expect(result.skippedDraftAspects).toContain('drafty');
    // The committed verdicts retain det+llm; the draft's stale verdict is evicted
    // by the draft-cleanup pass (no reviewer ever produced/changed it).
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Migration-shape payoff — the cost win ──────────────────
  it('migration shape: a det aspect DEFINITION change (description) re-runs det locally, llm NOT called', async () => {
    const tmpDir = await setupDetLlm('e2e-migration-win');
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // A change to the aspect's definition metadata (description). The drift tracker
    // hashes a status-stripped `aspect-meta:<id>` synthetic, not the raw yg-aspect.yaml,
    // so a definition change surfaces as the synthetic key changing.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/yg-aspect.yaml'),
      'name: Det\ndescription: structural shape (migrated)\nreviewer:\n  type: deterministic\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // Confirm the migration shape: upstream-only, attributable to det via a typed
    // aspectMeta identity cause.
    expect(coreResult.changedSource).toBeUndefined();
    expect(
      coreResult.changedUpstream?.some(
        c => c.identity?.kind === 'aspectMeta' && c.identity.aspectId === 'det',
      ),
    ).toBe(true);

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects runs end-to-end.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // The concrete cost win: only `det` re-runs locally, the llm provider is
    // never constructed/called — ZERO LLM calls for an aspect-yaml migration.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── I5 — a cross-node check-touched file change re-runs ONLY det ──
  //         (mirror of I1, but inverted provider outcome: the det aspect read a
  //          file owned by a RELATED node; when only that cross-node file
  //          changes, the change lands on the 'check-touched' layer →
  //          changedUpstream attributable to det → llm verdict carried forward,
  //          provider never called).
  it('I5: a cross-node check-touched file change re-runs ONLY the deterministic aspect; llm provider NOT called, llm verdict carried forward', async () => {
    // A cross-node path: NOT in this node's own mapping (mapping is
    // src/svc/index.ts). It is a file a related node owns that the det aspect
    // reads. Recording it under checkTouchedFiles[det] is exactly what a
    // prior approve of a graph-aware deterministic aspect would have done.
    const CROSS_NODE_PATH = 'src/related/dep.ts';
    const tmpDir = await setupDetLlm('e2e-i5-cross-node-stf');
    // Put the cross-node file on disk BEFORE recording the baseline so its
    // disk hash is captured in the baseline `files` (under the check-touched
    // layer that recordVerdicts folds in via checkTouchedFiles).
    await mkdir(path.dirname(path.join(tmpDir, CROSS_NODE_PATH)), { recursive: true });
    await writeFile(path.join(tmpDir, CROSS_NODE_PATH), 'export const dep = 1;\n');
    // Baseline: both det and llm approved; checkTouchedFiles maps the
    // cross-node path under det (the value is a placeholder — only the key path
    // participates in attribution and in the check-touched tracking entry).
    await recordVerdicts(
      tmpDir,
      { det: { verdict: 'approved' }, llm: { verdict: 'approved' } },
      { det: { [CROSS_NODE_PATH]: 'deadbeef'.repeat(8) } },
    );
    // The ONLY upstream change: the cross-node file's content changes.
    await writeFile(path.join(tmpDir, CROSS_NODE_PATH), 'export const dep = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    // ── Load-bearing layer assertions — WHY the fix works. The cross-node path
    // must land on the 'check-touched' layer → changedUpstream, and NOT on
    // changedSource (which would trip the conservative full-re-run guard in
    // selectDriftedAspects). Mirror the migration-shape test's core assertions.
    expect(coreResult.changedUpstream?.map(c => c.filePath)).toContain(CROSS_NODE_PATH);
    expect(coreResult.changedSource ?? []).toHaveLength(0);

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects runs end-to-end
    // and computes reReviewAspectIds={det} from the cross-node check-touched
    // change attributed to det via the baseline's checkTouchedFiles.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // The OPPOSITE of I1: the llm provider is NEVER called — only det re-runs.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // det WAS re-evaluated this run (it is in the re-review subset).
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    // The llm verdict is carried forward byte-for-byte from the prior baseline.
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── no-change → zero reviewer calls AND checkTouchedFiles preserved ──
  it('no-change: zero reviewer calls and checkTouchedFiles preserved byte-identical', async () => {
    const PRIOR_STF = { det: { 'src/svc/index.ts': 'deadbeef'.repeat(8) } };
    const tmpDir = await setupDetLlm('e2e-no-change-stf');
    // Record a baseline WITH checkTouchedFiles and both verdicts approved.
    await recordVerdicts(
      tmpDir,
      { det: { verdict: 'approved' }, llm: { verdict: 'approved' } },
      PRIOR_STF,
    );
    // No source edit, no upstream edit → genuine no-change.

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // Genuine no-change: neither source nor upstream drifted.
    expect(coreResult.action).toBe('no-change');
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.changedUpstream).toBeUndefined();
    // approveNode clones the prior baseline into pendingDriftState for no-change.
    expect(coreResult.pendingDriftState?.state.identity.aspects['det']?.checkTouched).toEqual(PRIOR_STF.det);

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects returns ∅ for real
    // (no changedSource, no changedUpstream) → no dispatch path.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    // No aspect dispatched at all — neither the structure runner nor the provider.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults).toBeUndefined();
    // The no-dispatch path must NOT wipe checkTouched — it is byte-identical.
    expect(result.pendingDriftState?.state.identity.aspects['det']?.checkTouched).toEqual(PRIOR_STF.det);
    // And the committed verdicts equal the full prior baseline.
    expect(result.pendingDriftState?.state.aspectVerdicts).toEqual({
      det: { verdict: 'approved' },
      llm: { verdict: 'approved' },
    });
    // The on-disk baseline retains the prior checkTouched too.
    const stored = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(stored?.identity.aspects['det']?.checkTouched).toEqual(PRIOR_STF.det);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
