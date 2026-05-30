import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import {
  buildAspectVerdicts,
  applyAspectVerdictsToResult,
  reviewerAborted,
} from '../../../src/core/approve-reviewer.js';
import type {
  AspectVerdict,
  ApproveResult,
  AspectVerificationResult,
  DriftNodeState,
} from '../../../src/model/drift.js';
import { buildTestGraph } from '../helpers/build-test-graph.js';

describe('DriftNodeState.aspectVerdicts persistence', () => {
  it('writes per-aspect verdicts and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-verdicts-'));
    try {
      const driftDir = join(dir, '.yggdrasil');
      await mkdir(driftDir, { recursive: true });
      const state: DriftNodeState = {
        hash: 'abc',
        files: { 'a.ts': 'sha1' },
        aspectVerdicts: {
          'audit-log': { verdict: 'approved' },
          'diagnostic-logging': { verdict: 'refused', reason: 'no diagnostic-id', errorSource: 'codeViolation' },
        },
      };
      await writeNodeDriftState(driftDir, 'orders/handler', state);
      const read = await readNodeDriftState(driftDir, 'orders/handler');
      expect(read?.aspectVerdicts?.['audit-log'].verdict).toBe('approved');
      expect(read?.aspectVerdicts?.['diagnostic-logging'].verdict).toBe('refused');
      expect(read?.aspectVerdicts?.['diagnostic-logging'].reason).toBe('no diagnostic-id');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('applyAspectVerdictsToResult — merge semantics', () => {
  function makeResult(): ApproveResult {
    return {
      action: 'approved',
      currentHash: 'h',
      pendingDriftState: {
        nodePath: 'n',
        state: { hash: 'h', files: {} },
      },
    } as ApproveResult;
  }

  it('filtered approve: prior verdicts for untouched aspects preserved', () => {
    const result = makeResult();
    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      B: { verdict: 'refused', reason: 'old reason', errorSource: 'codeViolation' },
    };
    const fresh: Record<string, AspectVerdict> = {
      A: { verdict: 'refused', reason: 'new reason', errorSource: 'codeViolation' },
    };
    applyAspectVerdictsToResult(result, fresh, [], prior, 'A', false);
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({
      A: { verdict: 'refused', reason: 'new reason', errorSource: 'codeViolation' },
      B: { verdict: 'refused', reason: 'old reason', errorSource: 'codeViolation' },
    });
  });

  it('full-node approve (no filter, reviewer ran): fresh verdicts replace prior', () => {
    const result = makeResult();
    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      B: { verdict: 'refused', reason: 'old', errorSource: 'codeViolation' },
    };
    const fresh: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
    };
    applyAspectVerdictsToResult(result, fresh, [], prior, undefined, false);
    // Full-node approve drops B because the only effective aspect is A
    // (carryForward is empty — B was not infra-skipped, it is simply gone).
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({
      A: { verdict: 'approved' },
    });
  });

  it('reviewer aborted (no reviewer ran on any aspect): prior verdicts preserved', () => {
    const result = makeResult();
    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      B: { verdict: 'refused', reason: 'old', errorSource: 'codeViolation' },
    };
    applyAspectVerdictsToResult(result, {}, [], prior, undefined, true);
    // Reviewer aborted (e.g. tier-resolution failed). Prior verdicts MUST
    // be preserved — empty verdicts is not "approved everything was deleted".
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual(prior);
  });

  it('all-draft node (reviewer not aborted, verdicts empty by design): writes {}', () => {
    const result = makeResult();
    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
    };
    // aborted = false because there are no non-draft effective aspects.
    applyAspectVerdictsToResult(result, {}, [], prior, undefined, false);
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({});
  });

  it('no pendingDriftState: no-op', () => {
    const result: ApproveResult = { action: 'no-change', currentHash: 'h' } as ApproveResult;
    applyAspectVerdictsToResult(result, { A: { verdict: 'approved' } }, [], undefined, undefined, false);
    // No throw, no mutation possible.
    expect(result.pendingDriftState).toBeUndefined();
  });
});

describe('reviewerAborted detection', () => {
  it('returns true when non-draft aspects exist but allAspectResults empty', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'A', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['A'] }],
    });
    const node = graph.nodes.get('n')!;
    expect(reviewerAborted(node, graph, {})).toBe(true);
  });

  it('returns false when allAspectResults has entries', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'A', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['A'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    expect(reviewerAborted(node, graph, results)).toBe(false);
  });

  it('returns false when all effective aspects are draft (no reviewer expected)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'A', status: 'draft' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['A'] }],
    });
    const node = graph.nodes.get('n')!;
    // Empty results + all-draft = NOT aborted (correctly skipped, will write {}).
    expect(reviewerAborted(node, graph, {})).toBe(false);
  });
});

describe('buildAspectVerdicts', () => {
  it('captures approved + refused verdicts for non-draft effective aspects', () => {
    const graph = buildTestGraph({
      aspects: [
        { id: 'A', status: 'enforced' },
        { id: 'B', status: 'advisory' },
        { id: 'C', status: 'draft' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['A', 'B', 'C'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      B: { satisfied: false, reason: 'bad', errorSource: 'codeViolation' },
      // C is draft, no reviewer entry expected.
    };
    const { verdicts } = buildAspectVerdicts(node, graph, results);
    expect(verdicts).toEqual({
      A: { verdict: 'approved' },
      B: { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
    });
  });

  it('returns {} when all effective aspects are draft', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'D', status: 'draft' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['D'] }],
    });
    const node = graph.nodes.get('n')!;
    expect(buildAspectVerdicts(node, graph, {}).verdicts).toEqual({});
  });

  it('infra error (errorSource: provider) — aspect is skipped, no refused verdict recorded', () => {
    // A provider failure is not a code violation. buildAspectVerdicts must skip
    // this aspect so that a transient infra failure cannot become a durable
    // CI-blocking refused verdict.
    const graph = buildTestGraph({
      aspects: [
        { id: 'A', status: 'enforced' },
        { id: 'B', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['A', 'B'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      B: { satisfied: false, reason: 'provider timeout', errorSource: 'provider' },
    };
    const { verdicts } = buildAspectVerdicts(node, graph, results);
    // B had a provider-error infra failure — must NOT appear as refused
    expect(verdicts['B']).toBeUndefined();
    // A's verdict is unaffected
    expect(verdicts['A']).toEqual({ verdict: 'approved' });
  });

  it('infra error (errorSource: checkRuntime) — aspect is skipped, no refused verdict recorded', () => {
    // A runner crash is not a code violation. buildAspectVerdicts must skip
    // it so the prior baseline verdict (if any) is carried forward.
    const graph = buildTestGraph({
      aspects: [
        { id: 'A', status: 'enforced' },
        { id: 'B', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['A', 'B'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: false, reason: 'real violation', errorSource: 'codeViolation' },
      B: { satisfied: false, reason: 'runner crash', errorSource: 'checkRuntime' },
    };
    const { verdicts } = buildAspectVerdicts(node, graph, results);
    // B had a runner-crash infra failure — must NOT appear as refused
    expect(verdicts['B']).toBeUndefined();
    // A is a genuine code violation — must still appear as refused
    expect(verdicts['A']).toEqual({ verdict: 'refused', reason: 'real violation', errorSource: 'codeViolation' });
  });

  it('codeViolation errorSource — still recorded as refused (only infra errors are skipped)', () => {
    const graph = buildTestGraph({
      aspects: [{ id: 'A', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['A'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: false, reason: 'missing header', errorSource: 'codeViolation' },
    };
    const { verdicts } = buildAspectVerdicts(node, graph, results);
    expect(verdicts['A']).toEqual({ verdict: 'refused', reason: 'missing header', errorSource: 'codeViolation' });
  });
});

describe('buildAspectVerdicts — infra error carry-forward via applyAspectVerdictsToResult', () => {
  it('full-node approve: prior approved verdict survives an infra-error re-run (filtered approve)', () => {
    // In a filtered approve (filterAspectId set), applyAspectVerdictsToResult
    // merges: prior verdicts for untouched aspects are preserved. If the targeted
    // aspect had an infra error, buildAspectVerdicts skips it, so the merged
    // result keeps the prior verdict for that aspect.
    const graph = buildTestGraph({
      aspects: [
        { id: 'A', status: 'enforced' },
        { id: 'B', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['A', 'B'] }],
    });
    const node = graph.nodes.get('n')!;

    // Simulate infra error on B (provider failure)
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      B: { satisfied: false, reason: 'provider timeout', errorSource: 'provider' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, results);

    // Prior baseline: B was approved
    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      B: { verdict: 'approved' },
    };

    const result: ApproveResult = {
      action: 'approved',
      currentHash: 'h',
      pendingDriftState: {
        nodePath: 'n',
        state: { hash: 'h', files: {} },
      },
    } as ApproveResult;

    // Filtered approve targeting aspect B
    applyAspectVerdictsToResult(result, verdicts, carryForward, prior, 'B', false);

    // B's prior 'approved' verdict must survive the infra-error re-run:
    // buildAspectVerdicts did not include B in verdicts (skipped), so
    // the filtered-approve merge keeps the prior entry for B.
    expect(result.pendingDriftState!.state.aspectVerdicts!['B']).toEqual({ verdict: 'approved' });
    expect(result.pendingDriftState!.state.aspectVerdicts!['A']).toEqual({ verdict: 'approved' });
  });

  it('FULL-NODE approve: infra error on an effective aspect carries forward its prior verdict (R4)', () => {
    // The bug: a full-node approve (no filterAspectId) where aspect B is still
    // effective but hit a provider/runner infra error this run. buildAspectVerdicts
    // skips B (no fresh verdict) and reports it in carryForward; the full-node
    // branch must reinstate B's prior good verdict instead of dropping it — else
    // the next `yg check` sees B as aspect-newly-active and blocks CI on a
    // transient failure.
    const graph = buildTestGraph({
      aspects: [
        { id: 'A', status: 'enforced' },
        { id: 'B', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['A', 'B'] }],
    });
    const node = graph.nodes.get('n')!;

    // A passed; B (still effective) failed with a provider infra error this run.
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      B: { satisfied: false, reason: 'provider timeout', errorSource: 'provider' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, results);
    // B is reported for carry-forward, not as a fresh verdict.
    expect(carryForward).toContain('B');
    expect(verdicts['B']).toBeUndefined();

    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      B: { verdict: 'approved' },
    };
    const result: ApproveResult = {
      action: 'approved',
      currentHash: 'h',
      pendingDriftState: { nodePath: 'n', state: { hash: 'h', files: {} } },
    } as ApproveResult;

    // Full-node approve (filterAspectId undefined, not aborted).
    applyAspectVerdictsToResult(result, verdicts, carryForward, prior, undefined, false);

    // B's prior 'approved' verdict survives; A is freshly re-approved.
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({
      A: { verdict: 'approved' },
      B: { verdict: 'approved' },
    });
  });

  it('FULL-NODE approve: a no-longer-effective prior aspect is still dropped (carryForward only reinstates effective ones)', () => {
    // Guards the carry-forward against over-reaching: an aspect present in the
    // prior baseline but no longer effective (removed from the node) must NOT be
    // resurrected. Only carryForward (effective + unevaluated) aspects survive.
    const graph = buildTestGraph({
      aspects: [{ id: 'A', status: 'enforced' }],
      nodes: [{ path: 'n', type: 'service', aspects: ['A'] }],
    });
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      A: { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, results);
    expect(carryForward).toEqual([]); // A was validly evaluated; nothing to carry

    const prior: Record<string, AspectVerdict> = {
      A: { verdict: 'approved' },
      GONE: { verdict: 'approved' }, // removed from node since last approve
    };
    const result: ApproveResult = {
      action: 'approved',
      currentHash: 'h',
      pendingDriftState: { nodePath: 'n', state: { hash: 'h', files: {} } },
    } as ApproveResult;

    applyAspectVerdictsToResult(result, verdicts, carryForward, prior, undefined, false);
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({ A: { verdict: 'approved' } });
  });
});
