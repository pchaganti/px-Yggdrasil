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
    applyAspectVerdictsToResult(result, fresh, prior, 'A', false);
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
    applyAspectVerdictsToResult(result, fresh, prior, undefined, false);
    // Full-node approve drops B because the only effective aspect is A.
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
    applyAspectVerdictsToResult(result, {}, prior, undefined, true);
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
    applyAspectVerdictsToResult(result, {}, prior, undefined, false);
    expect(result.pendingDriftState!.state.aspectVerdicts).toEqual({});
  });

  it('no pendingDriftState: no-op', () => {
    const result: ApproveResult = { action: 'no-change', currentHash: 'h' } as ApproveResult;
    applyAspectVerdictsToResult(result, { A: { verdict: 'approved' } }, undefined, undefined, false);
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
    const verdicts = buildAspectVerdicts(node, graph, results);
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
    expect(buildAspectVerdicts(node, graph, {})).toEqual({});
  });
});
