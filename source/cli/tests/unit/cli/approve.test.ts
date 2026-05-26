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

  it('shows LLM unavailable notice', () => {
    const result = makeApproveResult({
      action: 'approved',
      llmSkipped: 'unavailable',
    });
    const output = captureOutput(() => formatResult('some/node', result));
    expect(output).toContain('aspects not verified');
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
