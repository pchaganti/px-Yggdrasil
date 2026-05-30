import { describe, it, expect } from 'vitest';
import type { LlmApproveResult } from '../../../src/cli/approve.js';
import { formatResult, formatBatchOutput } from '../../../src/cli/approve.js';

function makeApproveResult(overrides: Partial<LlmApproveResult> = {}): LlmApproveResult {
  return {
    action: 'approved',
    currentHash: 'abcdef01',
    previousHash: '12345678',
    ...overrides,
  };
}

function captureOutput(fn: () => void): string {
  const chunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return chunks.join('');
}

describe('formatResult — LLM results', () => {
  it('displays aspect verification results in approve output', () => {
    const result = makeApproveResult({
      action: 'refused',
      refuseReasonData: { what: 'Reviewer verification found issues', why: 'Aspect check failed.', next: 'Fix violations and re-run.' },
      aspectResults: {
        'deterministic': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
        'pure-transforms': { satisfied: false, reason: 'fs.readFileSync on line 89', errorSource: 'codeViolation' as const },
      },
    });
    const output = captureOutput(() => formatResult('cli/core/validator', result));
    expect(output).toContain('SATISFIED');
    expect(output).toContain('NOT SATISFIED');
    expect(output).toContain('fs.readFileSync');
  });

  it('shows LLM unavailable notice with an actionable next step', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: 'unavailable',
    });
    const output = captureOutput(() => formatResult('some/node', result));
    // Structured what/why/next — what states aspects were not verified, next is actionable.
    expect(output).toContain('not reachable');
    expect(output).toContain('not verified');
    expect(output).toContain('re-run yg approve');
    expect(output).toContain('yg-config.yaml');
  });

});

describe('formatResult — advisory-only violations', () => {
  it('prints an informational (non-refusal) line for advisory violations on a passed node', () => {
    const result = makeApproveResult({
      action: 'approved',
      aspectResults: {
        'advisory-rule': { satisfied: false, reason: 'advisory issue on line 9', errorSource: 'codeViolation' as const },
      },
      advisoryViolations: [{ aspectId: 'advisory-rule', reason: 'advisory issue on line 9' }],
    });
    const output = captureOutput(() => formatResult('svc/thing', result));
    // Approved summary still printed.
    expect(output).toContain('Approved: svc/thing');
    // Structured what/why/next advisory line — NOT the red refusal, NOT "NOT SATISFIED".
    expect(output).toContain('advisory aspect violation');
    // The structured `what` still names the violated aspect id.
    expect(output).toContain('advisory-rule');
    // The `why` explains advisory aspects do not block.
    expect(output).toContain('do not block');
    // The per-violation reason (exempt LLM output) is still surfaced.
    expect(output).toContain('advisory issue on line 9');
    expect(output).not.toContain('NOT SATISFIED');
    expect(output).not.toContain('Reviewer found aspect violations');
  });

  it('counts an advisory-only node as approved (not failed) in batch output', () => {
    const results = [
      {
        nodePath: 'svc/a',
        result: makeApproveResult({
          action: 'approved',
          aspectResults: {
            'advisory-rule': { satisfied: false, reason: 'advisory issue', errorSource: 'codeViolation' as const },
          },
          advisoryViolations: [{ aspectId: 'advisory-rule', reason: 'advisory issue' }],
        }),
        skippedDraftAspects: [],
      },
    ];
    const output = captureOutput(() => formatBatchOutput(results));
    expect(output).toContain('1 approved, 0 failed.');
    // Structured advisory line still surfaces the aspect id and reason in batch output.
    expect(output).toContain('advisory aspect violation');
    expect(output).toContain('advisory-rule');
    expect(output).toContain('advisory issue');
  });
});

describe('formatBatchOutput', () => {
  it('outputs full formatResult for each node, not one-line summaries', () => {
    const results = [
      {
        nodePath: 'cli/core/loader',
        result: makeApproveResult({
          action: 'approved',
          aspectResults: {
            'deterministic': { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const },
          },
        }),
        skippedDraftAspects: [],
      },
      {
        nodePath: 'cli/core/validator',
        result: makeApproveResult({
          action: 'refused',
          refuseReasonData: { what: 'Reviewer verification found issues', why: 'Aspect check failed.', next: 'Fix violations and re-run.' },
          aspectResults: {
            'posix-paths': { satisfied: false, reason: 'Missing normalization on line 42', errorSource: 'codeViolation' as const },
          },
        }),
        skippedDraftAspects: [],
      },
    ];
    const output = captureOutput(() => formatBatchOutput(results));

    // Separator per node
    expect(output).toContain('─── cli/core/loader ─');
    expect(output).toContain('─── cli/core/validator ─');

    // Full output for approved node — not just "✓ approved"
    expect(output).toContain('Approved: cli/core/loader');
    expect(output).toContain('aspects satisfied');

    // Full output for refused node — not just "✗ aspect-violation"
    expect(output).toContain('NOT SATISFIED');
    expect(output).toContain('Missing normalization on line 42');

    // Summary at end
    expect(output).toContain('1 approved, 1 failed.');
  });
});
