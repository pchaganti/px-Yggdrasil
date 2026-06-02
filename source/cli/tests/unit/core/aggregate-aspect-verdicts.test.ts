import { describe, it, expect, afterAll } from 'vitest';
import { buildAspectVerdicts, reviewerAborted } from '../../../src/core/approve-reviewer.js';
import { computeEffectiveAspects, computeEffectiveAspectStatuses } from '../../../src/core/graph/aspects.js';
import type { AspectVerificationResult } from '../../../src/model/drift.js';
import { buildTestGraph, cleanupTestGraphs } from '../helpers/build-test-graph.js';

afterAll(() => cleanupTestGraphs());

// An aggregating aspect (reviewer.type: aggregate) is a content-less, check-less
// bundle that only `implies` children. It is EFFECTIVE on a node (so its implied
// children expand via channel 7), but it has NO own reviewer and therefore NO own
// verdict. It must be excluded from the verdict-expecting set so it never lands in
// carryForward nor surfaces as aspect-newly-active.
describe('aggregating aspect — effective expansion + verdict exclusion', () => {
  function graphWithBundle() {
    return buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['child-a', 'child-b'], status: 'enforced' },
        { id: 'child-a', status: 'enforced' },
        { id: 'child-b', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
  }

  it('expands the implied children as effective aspects on a node declaring the bundle', () => {
    const graph = graphWithBundle();
    const node = graph.nodes.get('n')!;
    const effective = computeEffectiveAspects(node, graph);
    expect(effective.has('bundle')).toBe(true);
    expect(effective.has('child-a')).toBe(true);
    expect(effective.has('child-b')).toBe(true);
  });

  it('the aggregate aspect itself records NO verdict and does NOT land in carryForward', () => {
    const graph = graphWithBundle();
    const node = graph.nodes.get('n')!;
    // Children evaluated; the aggregate has no reviewer result (it is never dispatched).
    const results: Record<string, AspectVerificationResult> = {
      'child-a': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      'child-b': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, results);
    expect(verdicts['child-a']).toEqual({ verdict: 'approved' });
    expect(verdicts['child-b']).toEqual({ verdict: 'approved' });
    // The aggregate must NOT appear as a verdict nor be carried forward.
    expect(verdicts['bundle']).toBeUndefined();
    expect(carryForward).not.toContain('bundle');
  });

  it('reviewerAborted is false when only an aggregate (no verdict-expecting aspect) plus its evaluated children are present', () => {
    // A node whose only DIRECT aspect is an aggregate still has verdict-expecting
    // children. With those children evaluated, results is non-empty so not aborted.
    const graph = graphWithBundle();
    const node = graph.nodes.get('n')!;
    const results: Record<string, AspectVerificationResult> = {
      'child-a': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
      'child-b': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' },
    };
    expect(reviewerAborted(node, graph, results)).toBe(false);
  });

  it('an aggregate whose implied child is independently draft contributes no verdict for itself', () => {
    // A DRAFT aggregate does not propagate, and its own verdict is never expected.
    // Here the aggregate is draft, so neither it nor (via it) the child is active.
    const graph = buildTestGraph({
      aspects: [
        { id: 'draft-bundle', reviewer: { type: 'aggregate' }, implies: ['some-child'], status: 'draft' },
        { id: 'some-child', status: 'draft' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['draft-bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    const statuses = computeEffectiveAspectStatuses(node, graph);
    // Both are draft → nothing to verify.
    expect(statuses.get('draft-bundle')).toBe('draft');
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, {});
    expect(verdicts).toEqual({});
    expect(carryForward).toEqual([]);
  });

  it('an enforced aggregate is excluded from verdicts even though its child expects one', () => {
    // The enforced aggregate propagates enforced status to its child via channel
    // 7. The CHILD expects a verdict (and is carried forward if unevaluated), but
    // the aggregate itself never does.
    const graph = buildTestGraph({
      aspects: [
        { id: 'bundle', reviewer: { type: 'aggregate' }, implies: ['child'], status: 'enforced' },
        { id: 'child', status: 'enforced' },
      ],
      nodes: [{ path: 'n', type: 'service', aspects: ['bundle'] }],
    });
    const node = graph.nodes.get('n')!;
    const { verdicts, carryForward } = buildAspectVerdicts(node, graph, {});
    // No reviewer results supplied: the child is carried forward, the aggregate is not.
    expect(carryForward).toContain('child');
    expect(carryForward).not.toContain('bundle');
    expect(verdicts).toEqual({});
  });
});
