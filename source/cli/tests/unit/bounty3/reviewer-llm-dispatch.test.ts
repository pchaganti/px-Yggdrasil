// Bounty 3 — adversarial coverage of reviewer DISPATCH: tier selection,
// consensus aggregation, fail-closed-on-infra, and error-source classification.
//
// HERMETIC: no network and no real LLM. Three layers:
//   A. Pure unit on verifyAspects/verifyWithConsensus via an in-memory mock
//      LlmProvider — exercises tie-breaking, fail-closed-under-consensus
//      error-source, and single-vote passthrough that the existing suites skip.
//   B. In-process integration on runApproveWithReviewer with createLlmProvider
//      vi.mock'd (mirrors tests/integration/multi-tier-approve.test.ts) — the
//      high-value INVARIANTS: tier routing + per-tier consensus call counts,
//      fail-closed writes NOTHING on provider-unreachable / no-reviewer, a
//      code-violation refusal commits a refused verdict, and verdicts are
//      recorded for advisory + enforced but NEVER for draft.
//   C. One E2E spawn of the real binary against a temp fixture with the
//      in-process mock reviewer, asserting exit code + persisted verdict.
//
// Determinism: ephemeral ports, fresh mkdtemp trees cleaned in finally/afterEach,
// no wall-clock reads inside assertions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { verifyAspects } from '../../../src/llm/aspect-verifier.js';
import type { LlmProvider, AspectResponse } from '../../../src/llm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'multi-tier-repo');

// ─────────────────────────────────────────────────────────────────────────────
// A. Pure unit — consensus aggregation + error-source classification
// ─────────────────────────────────────────────────────────────────────────────

/** A scripted provider: each call returns the next response in `queue`. */
function scriptedProvider(queue: AspectResponse[]): LlmProvider {
  let i = 0;
  return {
    verifyAspect: vi.fn(async (): Promise<AspectResponse> => {
      const r = queue[i++];
      if (!r) throw new Error(`scriptedProvider exhausted at call ${i}`);
      return r;
    }),
    isAvailable: vi.fn(async () => true),
  };
}

async function runOne(provider: LlmProvider, consensus: number): Promise<AspectResponse> {
  const results = await verifyAspects({
    provider,
    aspects: [{ id: 'a', description: 'd', content: 'rule' }],
    sourceFiles: [{ path: 's.ts', content: 'code' }],
    nodeDescription: 'n',
    nodePath: 'n/p',
    consensus,
  });
  return results['a'] as AspectResponse;
}

describe('A. consensus aggregation invariants', () => {
  it('EVEN consensus 1-1 tie REFUSES (satisfied must be strictly greater)', async () => {
    // N=2 split 1 satisfied / 1 not. `satisfied > notSatisfied` is false → refuse.
    // Every prior suite only tests odd N (3); the tie boundary is untested.
    const provider = scriptedProvider([
      { satisfied: true, reason: 'yes', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'no', errorSource: 'codeViolation' },
    ]);
    const r = await runOne(provider, 2);
    expect(r.satisfied).toBe(false);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(2);
  });

  it('EVEN consensus 2-0 all-satisfied APPROVES', async () => {
    const provider = scriptedProvider([
      { satisfied: true, reason: 'yes1', errorSource: 'codeViolation' },
      { satisfied: true, reason: 'yes2', errorSource: 'codeViolation' },
    ]);
    const r = await runOne(provider, 2);
    expect(r.satisfied).toBe(true);
  });

  it('consensus-fail where ALL losing votes are PROVIDER errors classifies as provider (fail-closed)', async () => {
    // Fail-closed under consensus: if the only verdicts are provider errors, the
    // aggregate MUST be errorSource:'provider' so approve refuses on infra and
    // commits nothing. Misclassifying as codeViolation would commit a refused
    // verdict over code the reviewer never validly saw.
    const provider = scriptedProvider([
      { satisfied: false, reason: 'boom1', errorSource: 'provider' },
      { satisfied: false, reason: 'boom2', errorSource: 'provider' },
      { satisfied: false, reason: 'boom3', errorSource: 'provider' },
    ]);
    const r = await runOne(provider, 3);
    expect(r.satisfied).toBe(false);
    expect(r.errorSource).toBe('provider');
  });

  it('consensus-fail MIXED (provider + code) classifies as codeViolation', async () => {
    // If ANY losing vote is a genuine code violation, the node is treated as a
    // real refusal, not pure infra. allProvider=false → 'codeViolation'.
    const provider = scriptedProvider([
      { satisfied: false, reason: 'real-violation', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'boom', errorSource: 'provider' },
      { satisfied: false, reason: 'boom2', errorSource: 'provider' },
    ]);
    const r = await runOne(provider, 3);
    expect(r.satisfied).toBe(false);
    expect(r.errorSource).toBe('codeViolation');
  });

  it('consensus-pass reason is taken from a SATISFIED vote, not a dissenting one', async () => {
    const provider = scriptedProvider([
      { satisfied: false, reason: 'DISSENT', errorSource: 'codeViolation' },
      { satisfied: true, reason: 'WINNER', errorSource: 'codeViolation' },
      { satisfied: true, reason: 'WINNER2', errorSource: 'codeViolation' },
    ]);
    const r = await runOne(provider, 3);
    expect(r.satisfied).toBe(true);
    expect(r.reason).not.toBe('DISSENT');
    expect(['WINNER', 'WINNER2']).toContain(r.reason);
  });

  it('single-vote (consensus<=1) PRESERVES the provider error-source verbatim', async () => {
    // The consensus<=1 path returns provider.verifyAspect() directly, so a
    // provider-error verdict must flow through unaltered — this is how a single
    // failed reviewer call surfaces as infra (fail-closed) downstream.
    const provider = scriptedProvider([
      { satisfied: false, reason: 'endpoint down', errorSource: 'provider' },
    ]);
    const r = await runOne(provider, 1);
    expect(r).toEqual({ satisfied: false, reason: 'endpoint down', errorSource: 'provider' });
    expect(provider.verifyAspect).toHaveBeenCalledTimes(1);
  });

  it('EVEN-consensus tie where the lone dissent is a PROVIDER error → provider-classified refusal', async () => {
    // N=2: 1 satisfied + 1 provider-error. Tie (1 !> 1) → refuse; the only losing
    // vote is a provider error so allProvider=true → errorSource:'provider'. A
    // single transient provider error under even consensus flips a would-pass into
    // an infra refusal (fail-closed). Untested boundary.
    const provider = scriptedProvider([
      { satisfied: true, reason: 'yes', errorSource: 'codeViolation' },
      { satisfied: false, reason: 'endpoint flaked', errorSource: 'provider' },
    ]);
    const r = await runOne(provider, 2);
    expect(r.satisfied).toBe(false);
    expect(r.errorSource).toBe('provider');
  });

  it('consensus 0 is treated as single-vote (no multiplication)', async () => {
    const provider = scriptedProvider([
      { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    ]);
    const r = await runOne(provider, 0);
    expect(r.satisfied).toBe(true);
    expect(provider.verifyAspect).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. In-process integration — runApproveWithReviewer dispatch invariants
//    createLlmProvider is mocked so NO real provider/network is touched.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

// Imports that must resolve AFTER the mock factory is registered.
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { recordBaselineForAllMappedNodes } from '../helpers/seed-baseline.js';
import { createLlmProvider } from '../../../src/llm/index.js';
import type { LlmConfig, Graph } from '../../../src/model/graph.js';

const mockCreate = vi.mocked(createLlmProvider);

function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: vi.fn(async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const })),
    isAvailable: vi.fn(async () => true),
    ...overrides,
  };
}

describe('B. runApproveWithReviewer dispatch invariants (in-process, mocked provider)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    for (const p of cleanup.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });

  async function setupRepo(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-b3-'));
    cleanup.push(root);
    await cp(FIXTURE, root, { recursive: true });
    return root;
  }

  async function approveWithProvider(
    graph: Graph,
    nodePath: string,
    factory: (cfg: LlmConfig) => LlmProvider,
  ): Promise<Awaited<ReturnType<typeof runApproveWithReviewer>>> {
    const core = await approveNode(graph, nodePath);
    mockCreate.mockImplementation(factory);
    return runApproveWithReviewer({
      graph,
      nodePath,
      result: core,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
  }

  it('TIER SELECTION: explicit-tier aspect and default-tier aspect each get their own consensus count', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(root);
    // payments: requires-logging (default tier `standard`, consensus 1) +
    //           requires-audit (explicit tier `deep`, consensus 3).
    // Each provider instance counts how many verifyAspect calls it serves.
    const callsByConsensus: number[] = [];
    await approveWithProvider(graph, 'payments', (cfg) => {
      const count = { n: 0 };
      callsByConsensus.push(cfg.consensus);
      return provider({
        verifyAspect: vi.fn(async () => {
          count.n++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        }),
      });
    });

    // One provider built per tier (2 tiers used on this node).
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(callsByConsensus.sort()).toEqual([1, 3]);
  });

  it('TIER SELECTION: total reviewer calls = sum of each tier consensus (1 + 3 = 4)', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 3;\n');

    const graph = await loadGraph(root);
    let totalCalls = 0;
    await approveWithProvider(graph, 'payments', () =>
      provider({
        verifyAspect: vi.fn(async () => {
          totalCalls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        }),
      }),
    );
    // requires-logging@standard(consensus 1) + requires-audit@deep(consensus 3) = 4.
    expect(totalCalls).toBe(4);
  });

  it('clean APPROVE records an approved verdict for every effective non-draft LLM aspect', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 4;\n');

    const graph = await loadGraph(root);
    const out = await approveWithProvider(graph, 'payments', () => provider());
    expect(out.action).not.toBe('refused');

    const state = await readNodeDriftState(graph.rootPath, 'payments');
    expect(state).toBeDefined();
    expect(state!.aspectVerdicts['requires-logging']).toEqual({ verdict: 'approved' });
    expect(state!.aspectVerdicts['requires-audit']).toEqual({ verdict: 'approved' });
  });

  it('FAIL-CLOSED: provider unreachable → refused, prior baseline left untouched (no commit)', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    const graph0 = await loadGraph(root);
    const before = await readNodeDriftState(graph0.rootPath, 'payments');
    expect(before).toBeDefined();
    const beforeHash = before!.hash;

    // Drift the source, then approve against an UNREACHABLE provider.
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 5;\n');
    const graph = await loadGraph(root);
    // CONTROL: confirm the edit genuinely drifts (core action is approved, not
    // no-change) so the "hash unchanged" assertion below proves fail-closed, not
    // a coincidental no-op.
    const core = await approveNode(graph, 'payments');
    expect(core.action).toBe('approved');
    mockCreate.mockImplementation(() => provider({ isAvailable: vi.fn(async () => false) }));
    const out = await runApproveWithReviewer({
      graph, nodePath: 'payments', result: core, rootPath: graph.rootPath, secretsByProvider: new Map(),
    });

    expect(out.action).toBe('refused');
    expect(out.llmSkipped).toBe('unavailable');
    // FAIL-CLOSED INVARIANT: the persisted baseline is byte-for-byte unchanged —
    // the hash did NOT advance over the unverified edit, so drift stays visible.
    const after = await readNodeDriftState(graph.rootPath, 'payments');
    expect(after!.hash).toBe(beforeHash);
  });

  it('FAIL-CLOSED: an INFRA error from one aspect refuses WITHOUT committing — drift stays red', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    const beforeHash = (await readNodeDriftState((await loadGraph(root)).rootPath, 'payments'))!.hash;

    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 6;\n');
    const graph = await loadGraph(root);
    const core = await approveNode(graph, 'payments');
    expect(core.action).toBe('approved'); // CONTROL: edit really drifted
    mockCreate.mockImplementation(() =>
      provider({
        verifyAspect: vi.fn(async () => ({ satisfied: false, reason: 'api 500', errorSource: 'provider' as const })),
      }),
    );
    const out = await runApproveWithReviewer({
      graph, nodePath: 'payments', result: core, rootPath: graph.rootPath, secretsByProvider: new Map(),
    });

    expect(out.action).toBe('refused');
    const after = await readNodeDriftState(graph.rootPath, 'payments');
    // No commit on infra failure: hash unchanged, prior approved verdicts intact
    // (carried forward, NOT overwritten with a refused/provider verdict).
    expect(after!.hash).toBe(beforeHash);
    expect(after!.aspectVerdicts['requires-logging']).toEqual({ verdict: 'approved' });
  });

  it('ERROR-SOURCE: a CODE-violation refusal commits a refused verdict (drift advances, stays red)', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    const beforeHash = (await readNodeDriftState((await loadGraph(root)).rootPath, 'payments'))!.hash;

    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 7;\n');
    const graph = await loadGraph(root);
    const core = await approveNode(graph, 'payments');
    expect(core.action).toBe('approved'); // CONTROL: edit really drifted
    mockCreate.mockImplementation(() =>
      provider({
        verifyAspect: vi.fn(async () => ({ satisfied: false, reason: 'missing audit event', errorSource: 'codeViolation' as const })),
      }),
    );
    const out = await runApproveWithReviewer({
      graph, nodePath: 'payments', result: core, rootPath: graph.rootPath, secretsByProvider: new Map(),
    });

    expect(out.action).toBe('refused');
    const after = await readNodeDriftState(graph.rootPath, 'payments');
    expect(after).toBeDefined();
    // Distinguishing invariant vs the infra case above: a code violation DOES
    // commit. The hash advances over the edit and a refused verdict is persisted.
    expect(after!.hash).not.toBe(beforeHash);
    const verdicts = Object.values(after!.aspectVerdicts);
    expect(verdicts.some(v => v.verdict === 'refused')).toBe(true);
  });

  it('NO REVIEWER configured but node has LLM aspects → fail-closed refused, nothing committed', async () => {
    const root = await setupRepo();
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    const beforeHash = (await readNodeDriftState((await loadGraph(root)).rootPath, 'payments'))!.hash;

    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 8;\n');
    const graph = await loadGraph(root);
    // Strip the reviewer config entirely.
    (graph.config as { reviewer?: unknown }).reviewer = undefined;

    const core = await approveNode(graph, 'payments');
    expect(core.action).toBe('approved'); // CONTROL: edit really drifted
    const out = await runApproveWithReviewer({
      graph,
      nodePath: 'payments',
      result: core,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(out.action).toBe('refused');
    expect(out.llmSkipped).toBe('unavailable');
    // createLlmProvider must never be called when there is no reviewer.
    expect(mockCreate).not.toHaveBeenCalled();
    const after = await readNodeDriftState(graph.rootPath, 'payments');
    expect(after!.hash).toBe(beforeHash);
  });

  it('DRAFT aspect: never dispatched and NO verdict recorded; non-draft sibling still approved', async () => {
    const root = await setupRepo();
    // Flip requires-audit (the explicit-tier LLM aspect) to draft.
    await writeFile(
      path.join(root, '.yggdrasil', 'aspects', 'requires-audit', 'yg-aspect.yaml'),
      'name: Requires Audit\ndescription: "Every mutation must emit an audit event"\nstatus: draft\nreviewer:\n  type: llm\n  tier: deep\n',
    );
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 9;\n');

    const graph = await loadGraph(root);
    let calls = 0;
    const out = await approveWithProvider(graph, 'payments', () =>
      provider({
        verifyAspect: vi.fn(async () => {
          calls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        }),
      }),
    );

    expect(out.action).not.toBe('refused');
    expect(out.skippedDraftAspects).toContain('requires-audit');
    // Only requires-logging (standard, consensus 1) ran → exactly 1 reviewer call.
    expect(calls).toBe(1);

    const state = await readNodeDriftState(graph.rootPath, 'payments');
    // INVARIANT: draft aspects carry NO recorded verdict.
    expect(state!.aspectVerdicts['requires-audit']).toBeUndefined();
    expect(state!.aspectVerdicts['requires-logging']).toEqual({ verdict: 'approved' });
  });

  it('ADVISORY refusal: verdict IS recorded (refused) and the node is NOT refused (non-blocking)', async () => {
    const root = await setupRepo();
    // Make requires-logging advisory; refuse it from the reviewer.
    await writeFile(
      path.join(root, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'),
      'name: Requires Logging\ndescription: "Every public method must log on entry"\nstatus: advisory\nreviewer:\n  type: llm\n',
    );
    // Keep requires-audit happy so the only refusal is the advisory one.
    await recordBaselineForAllMappedNodes(await loadGraph(root));
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 10;\n');

    const graph = await loadGraph(root);
    const out = await approveWithProvider(graph, 'payments', (cfg) =>
      provider({
        verifyAspect: vi.fn(async () => {
          // standard tier (consensus 1) → requires-logging; deep → requires-audit.
          // requires-logging must REFUSE; requires-audit must PASS.
          const refuse = cfg.consensus === 1;
          return refuse
            ? { satisfied: false, reason: 'advisory: no logging', errorSource: 'codeViolation' as const }
            : { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        }),
      }),
    );

    // Advisory-only code violation: node is NOT refused.
    expect(out.action).not.toBe('refused');
    expect(out.advisoryViolations?.some(v => v.aspectId === 'requires-logging')).toBe(true);

    const state = await readNodeDriftState(graph.rootPath, 'payments');
    // Advisory verdict IS persisted (recorded for advisory + enforced), as refused.
    expect(state!.aspectVerdicts['requires-logging']).toMatchObject({ verdict: 'refused' });
    expect(state!.aspectVerdicts['requires-audit']).toEqual({ verdict: 'approved' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. E2E — real binary spawn against the in-process mock reviewer
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { startMockReviewer, runAsync } from '../../e2e/support/mock-reviewer.js';

const BIN = path.join(CLI_ROOT, 'dist', 'bin.js');
const E2E_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const binExists = existsSync(BIN);

describe.skipIf(!binExists)('C. E2E spawn — fail-closed exit code + persisted verdict', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const p of cleanup.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });

  function fixtureCopy(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'yg-b3-e2e-')).then(async (dir) => {
      cleanup.push(dir);
      await cp(E2E_FIXTURE, dir, { recursive: true });
      return dir;
    });
  }

  function pointReviewer(dir: string, endpoint: string): void {
    const p = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    writeFileSync(
      p,
      readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`),
      'utf-8',
    );
  }

  const baselinePath = (dir: string, node: string) =>
    path.join(dir, '.yggdrasil', '.drift-state', ...node.split('/')) + '.json';

  it('an enforced LLM REFUSE exits 1 and persists a refused verdict in the baseline', async () => {
    const dir = await fixtureCopy();
    const mock = await startMockReviewer({
      respond: () => ({ satisfied: false, reason: 'the file has no leading comment' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('has-doc-comment');
      // A code-violation refusal of an enforced aspect commits its refused verdict.
      const bp = baselinePath(dir, 'services/orders');
      expect(existsSync(bp)).toBe(true);
      const state = JSON.parse(readFileSync(bp, 'utf-8')) as {
        aspectVerdicts: Record<string, { verdict: string }>;
      };
      expect(state.aspectVerdicts['has-doc-comment']?.verdict).toBe('refused');
      expect(mock.chatCount()).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it('an UNREACHABLE provider exits 1 and writes NO baseline (fail-closed)', async () => {
    const dir = await fixtureCopy();
    // Mock reports the model unavailable → availability check fails → infra refuse.
    const mock = await startMockReviewer({ available: false });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['approve', '--node', 'services/orders'], dir);
      expect(r.status).toBe(1);
      // Fail-closed: no baseline written for a never-verified node.
      expect(existsSync(baselinePath(dir, 'services/orders'))).toBe(false);
    } finally {
      await mock.close();
    }
  });
});
