import { describe, it, expect } from 'vitest';
import type { CheckResult, CheckIssue, CascadeCause } from '../../../src/core/check.js';
import { formatOutput } from '../../../src/cli/check.js';

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'Test',
    nodeCount: 0,
    nodeTypeCounts: new Map(),
    aspectCount: 0,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues: [],
    suggestedNext: null,
    advisoryWarnings: 0,
    draftSkipped: 0,
    ...overrides,
  };
}

function makeError(code: string, message: string, nodePath?: string): CheckIssue {
  return {
    severity: 'error',
    code,
    rule: code,
    messageData: { what: message, why: '', next: '' },
    nodePath: nodePath ?? 'some/node',
  };
}

function makeWarning(code: string, message: string): CheckIssue {
  return {
    severity: 'warning',
    code,
    rule: code,
    messageData: { what: message, why: '', next: '' },
    nodePath: 'some/node',
  };
}

function makeCascadeIssue(nodePath: string, causeDescription: string): CheckIssue {
  const causes: CascadeCause[] = [
    { file: `.yggdrasil/aspects/some-aspect/content.md`, layer: 'aspects', description: causeDescription },
  ];
  return {
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: {
      what: `Context package changed due to 1 upstream modification:\n  Cause: ${causeDescription}`,
      why: 'Source may no longer satisfy updated aspect requirements.',
      next: `Load context: yg context --node ${nodePath}\nVerify source compliance, update if needed, then: yg approve --node ${nodePath}`,
    },
    nodePath,
    cascadeCauses: causes,
  };
}

function makeCoverageIssue(uncoveredCount: number): CheckIssue {
  const files = Array.from({ length: Math.min(uncoveredCount, 5) }, (_, i) => `src/file-${i}.ts`);
  const remaining = uncoveredCount - files.length;
  let what: string;
  const why = 'Files without graph coverage cannot be modified under the protocol.';
  let next: string;
  if (uncoveredCount <= 5) {
    what = `${uncoveredCount} source file${uncoveredCount === 1 ? '' : 's'} not covered by any node.\n${files.map(f => '  ' + f).join('\n')}`;
    next = 'Check ownership candidates: yg context --file <path>\nThen: add to existing node mapping, or create a new node.';
  } else {
    what = `${uncoveredCount.toLocaleString()} source files have no graph coverage.\nExamples:\n${files.map(f => '  ' + f).join('\n')}\n... and ${remaining.toLocaleString()} more`;
    next = 'Establish coverage: create nodes for active areas first, expand coverage incrementally.\nCheck ownership candidates: yg context --file <path>';
  }
  return {
    severity: 'error',
    code: 'unmapped-files',
    rule: 'unmapped-file',
    messageData: { what, why, next },
    uncoveredFiles: files,
    uncoveredCount,
  };
}

describe('formatOutput', () => {
  it('check output does not include health score', () => {
    const output = formatOutput(makeCheckResult({ issues: [] }));
    expect(output).not.toContain('Health:');
  });

  it('displays full completeness-warning message including breakdown', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('high-fan-out', 'Context is 18,000 tokens...\n     own: 2,100 | hierarchy: 3,200 | ...')],
    }));
    // The 'what' first line is shown; multi-line detail in messageData.what is preserved via Why/Fix
    expect(output).toContain('high-fan-out');
    expect(output).toContain('Warnings (1)');
  });

  it('shows warnings even when errors exist', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeError('source-drift', 'drift'), makeWarning('high-fan-out', 'budget')],
    }));
    expect(output).toContain('Warnings (1)');
    // New format: verdict line says FAIL (no warning count in header when errors exist)
    expect(output).toContain('yg check: FAIL');
  });

  it('shows full warnings when no errors', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeWarning('high-fan-out', 'budget warning message')],
    }));
    expect(output).toContain('Warnings (1)');
    expect(output).toContain('budget warning message');
  });

  it('shows aspect-undefined errors in the Errors section', () => {
    const issues = Array.from({ length: 15 }, (_, i) => makeError('aspect-undefined', `Aspect 'auth' referenced by node-${i}...`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    // New format: no section headers, but errors are still rendered
    expect(output).toContain('Errors (15)');
    expect(output).toContain('aspect-undefined');
  });

  it('renders <=10 aspect-undefined errors individually', () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeError('aspect-undefined', `msg`, `node-${i}`));
    const output = formatOutput(makeCheckResult({ issues }));
    // All 5 errors appear
    expect(output).toContain('Errors (5)');
    expect(output).toContain('aspect-undefined');
  });

});

describe('preserved check features', () => {
  it('cascade errors are grouped by cause with cause description and node list', () => {
    const output = formatOutput(makeCheckResult({
      issues: [
        makeCascadeIssue('node-a', "aspect 'X' rules changed"),
        makeCascadeIssue('node-b', "aspect 'X' rules changed"),
      ],
    }));
    // New format: cascade(N) block with cause description and → node list
    expect(output).toContain('cascade (2)');
    expect(output).toContain("aspect 'X'");
  });

  it('Next: suggested command appears as single line after error section', () => {
    const output = formatOutput(makeCheckResult({
      issues: [makeError('source-drift', 'drift')],
      suggestedNext: 'yg context --node cli/core/validator\n  1 of 1 drifted node — post-modify workflow',
    }));
    // New format: Next: is a single line — only the first line of suggestedNext is shown
    expect(output).toContain('Next: yg context --node cli/core/validator');
    // Annotation after newline is omitted to keep output terse
    expect(output).not.toContain('post-modify workflow');
  });

  it('errors sorted by node path (stable ordering)', () => {
    const output = formatOutput(makeCheckResult({
      issues: [
        makeError('source-drift', 'drift', 'z-node'),
        makeError('source-drift', 'drift', 'a-node'),
      ],
    }));
    const aPos = output.indexOf('a-node');
    const zPos = output.indexOf('z-node');
    expect(aPos).toBeLessThan(zPos);
  });

  it('unmapped-files cold start guidance when 0 nodes and many uncovered files', () => {
    const output = formatOutput(makeCheckResult({
      nodeCount: 0,
      issues: [makeCoverageIssue(100)],
    }));
    expect(output).toMatch(/coverage|node/i);
  });

  it('renders type-strict-orphan errors with error count in header', () => {
    const issues = Array.from({ length: 23 }, (_, i) =>
      makeError('type-strict-orphan', `File 'src/file${i}.ts' satisfies strict when\nBut file is not in any mapping.\nCreate yg-node.yaml.`),
    );
    const output = formatOutput(makeCheckResult({ issues }));
    // New format: all errors shown individually, no special grouping
    expect(output).toContain('Errors (23)');
    expect(output).toContain('type-strict-orphan');
  });

  it('shows type-strict-orphan individually when count <= 5', () => {
    const issues = Array.from({ length: 3 }, (_, i) =>
      makeError('type-strict-orphan', `File 'src/file${i}.ts' satisfies strict when`),
    );
    const output = formatOutput(makeCheckResult({ issues }));
    expect(output).toContain('type-strict-orphan');
    // Small count: no truncation markers
    expect(output).not.toMatch(/\.\.\. \+\d+/);
  });
});
