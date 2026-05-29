/**
 * Tests for the new terse agent-friendly `yg check` output format.
 *
 * All tests use synthesised CheckResult inputs — no real repo spin-up needed.
 * The renderer is pure (returns a string) so every case is deterministic.
 */
import { describe, it, expect } from 'vitest';
import type { CheckResult, CheckIssue, CascadeCause } from '../../../src/core/check.js';
import { formatOutput } from '../../../src/cli/check.js';

// ── Helpers ───────────────────────────────────────────────────

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    projectName: 'MyProject',
    nodeCount: 127,
    nodeTypeCounts: new Map([['module', 21], ['command', 15]]),
    aspectCount: 28,
    flowCount: 9,
    coveredFiles: 465,
    totalFiles: 465,
    issues: [],
    suggestedNext: null,
    advisoryWarnings: 0,
    draftSkipped: 0,
    ...overrides,
  };
}

function makeError(
  code: string,
  what: string,
  why = 'some why',
  next = 'some fix',
  nodePath = 'cli/some/node',
): CheckIssue {
  return {
    severity: 'error',
    code,
    rule: code,
    messageData: { what, why, next },
    nodePath,
  };
}

function makeAdvisoryWarning(
  aspectId: string,
  nodePath: string,
  why = 'advisory violation reason',
): CheckIssue {
  return {
    severity: 'warning',
    code: 'aspect-violation-advisory',
    rule: 'aspect-violation-advisory',
    messageData: {
      what: `Node '${nodePath}' fails advisory aspect '${aspectId}'.`,
      why,
      next: 'Optional: address the violation or accept the warning as known state.',
    },
    nodePath,
  };
}

function makeCascadeIssue(
  nodePath: string,
  aspectId: string,
  causeFile = `.yggdrasil/aspects/${aspectId}/check.mjs`,
): CheckIssue {
  const causes: CascadeCause[] = [
    { file: causeFile, layer: 'aspects', description: `aspect '${aspectId}' check.mjs changed` },
  ];
  return {
    severity: 'error',
    code: 'upstream-drift',
    rule: 'cascade-drift',
    messageData: {
      what: `Context package changed due to 1 upstream modification:\n  Cause: aspect '${aspectId}' check.mjs changed`,
      why: 'Source may no longer satisfy updated aspect requirements.',
      next: `yg approve --node ${nodePath}`,
    },
    nodePath,
    cascadeCauses: causes,
  };
}

// ── 1. Clean PASS ─────────────────────────────────────────────

describe('clean PASS', () => {
  it('single-line output: verdict + metrics, no trailing sections', () => {
    const out = formatOutput(makeResult());
    const lines = out.trim().split('\n');
    // Exactly one non-empty line for a clean pass
    expect(lines.filter(l => l.trim())).toHaveLength(1);
    expect(out).toContain('yg check: PASS');
    expect(out).toContain('127 nodes');
    expect(out).toContain('465/465 files');
    expect(out).toContain('28 aspects');
    expect(out).toContain('9 flows');
  });

  it('no draft suffix when draftSkipped is 0', () => {
    const out = formatOutput(makeResult({ draftSkipped: 0 }));
    expect(out).not.toMatch(/draft/);
  });

  it('adds draft suffix when draftSkipped > 0', () => {
    const out = formatOutput(makeResult({ draftSkipped: 3 }));
    expect(out).toContain('3 draft');
  });

  it('no node type breakdown in header', () => {
    const out = formatOutput(makeResult());
    expect(out).not.toContain('module');
    expect(out).not.toContain('command');
  });

  it('100% coverage shown as X/Y files (no percentage)', () => {
    const out = formatOutput(makeResult({ coveredFiles: 100, totalFiles: 100 }));
    expect(out).toContain('100/100 files');
    expect(out).not.toMatch(/\d+%/);
  });

  it('zero totalFiles omits files metric', () => {
    const out = formatOutput(makeResult({ totalFiles: 0, coveredFiles: 0 }));
    expect(out).not.toContain('files');
  });
});

// ── 2. PASS with warnings ─────────────────────────────────────

describe('PASS with warnings', () => {
  it('verdict includes warning count, warnings section present', () => {
    const issues = [
      makeAdvisoryWarning('rate-limiting', 'cli/payments/handler', 'direct DB fallback'),
      makeAdvisoryWarning('token-expiry-check', 'cli/auth/middleware', 'token expiry bypassed'),
    ];
    const out = formatOutput(makeResult({ issues, advisoryWarnings: 2 }));
    expect(out).toContain('yg check: PASS (2 warnings)');
    expect(out).toContain('Warnings (2)');
  });

  it('no Next: line for warnings-only result', () => {
    const issues = [makeAdvisoryWarning('some-aspect', 'cli/node')];
    const out = formatOutput(makeResult({ issues, advisoryWarnings: 1 }));
    expect(out).not.toMatch(/^Next:/m);
  });

  it('each warning shows advisory label, node path, aspect name', () => {
    const issues = [makeAdvisoryWarning('rate-limiting', 'cli/payments/handler')];
    const out = formatOutput(makeResult({ issues, advisoryWarnings: 1 }));
    expect(out).toContain('advisory');
    expect(out).toContain('cli/payments/handler');
    expect(out).toContain('rate-limiting');
  });

  it('warning Why and Fix lines present', () => {
    const issues = [makeAdvisoryWarning('rate-limiting', 'cli/payments/handler', 'circuit-breaker missing')];
    const out = formatOutput(makeResult({ issues, advisoryWarnings: 1 }));
    expect(out).toContain('Why:');
    expect(out).toContain('circuit-breaker missing');
    expect(out).toContain('Fix:');
  });

  it('advisory note in Fix line', () => {
    const issues = [makeAdvisoryWarning('rate-limiting', 'cli/payments/handler')];
    const out = formatOutput(makeResult({ issues, advisoryWarnings: 1 }));
    expect(out).toContain('advisory — not blocking');
  });
});

// ── 3. FAIL cascade-heavy ─────────────────────────────────────

describe('FAIL cascade-heavy', () => {
  it('verdict is FAIL, no warning count when 0 warnings', () => {
    const nodes = ['cli/commands/approve', 'cli/commands/aspects', 'cli/commands/check'];
    const issues = nodes.map(n => makeCascadeIssue(n, 'sibling-test-file'));
    const out = formatOutput(makeResult({ issues }));
    expect(out).toContain('yg check: FAIL');
    expect(out).not.toContain('warnings');
  });

  it('cascade grouped into single block with cause and arrow', () => {
    const nodes = ['cli/commands/approve', 'cli/commands/aspects', 'cli/commands/check'];
    const issues = nodes.map(n => makeCascadeIssue(n, 'sibling-test-file'));
    const out = formatOutput(makeResult({ issues }));
    expect(out).toContain("cascade (3)");
    expect(out).toContain('sibling-test-file');
    expect(out).toContain('→');
  });

  it('cascade Fix uses --aspect flag', () => {
    const nodes = ['cli/commands/approve', 'cli/commands/aspects'];
    const issues = nodes.map(n => makeCascadeIssue(n, 'sibling-test-file'));
    const out = formatOutput(makeResult({ issues }));
    expect(out).toContain('yg approve --aspect sibling-test-file');
  });

  it('node list shows names inline with brace notation', () => {
    const nodes = ['cli/commands/approve', 'cli/commands/aspects', 'cli/commands/check'];
    const issues = nodes.map(n => makeCascadeIssue(n, 'sibling-test-file'));
    const out = formatOutput(makeResult({ issues }));
    // All 3 nodes should appear in the output
    for (const n of ['approve', 'aspects', 'check']) {
      expect(out).toContain(n);
    }
  });

  it('Next: line present at bottom for cascade errors', () => {
    const nodes = ['cli/commands/approve', 'cli/commands/aspects'];
    const issues = nodes.map(n => makeCascadeIssue(n, 'sibling-test-file'));
    const out = formatOutput(makeResult({
      issues,
      suggestedNext: 'yg approve --aspect sibling-test-file',
    }));
    expect(out).toMatch(/^Next: yg approve --aspect sibling-test-file/m);
  });
});

// ── 4. Node list truncation ───────────────────────────────────

describe('node list truncation', () => {
  it('exactly 6 nodes shown verbatim (no truncation)', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => `cli/commands/cmd${i}`);
    const issues = nodes.map(n => makeCascadeIssue(n, 'my-aspect'));
    const out = formatOutput(makeResult({ issues }));
    for (const n of nodes) {
      const name = n.split('/').pop()!;
      expect(out).toContain(name);
    }
    expect(out).not.toContain('... +');
  });

  it('7 nodes: shows first 6 then ... +1', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => `cli/commands/cmd${i}`);
    const issues = nodes.map(n => makeCascadeIssue(n, 'my-aspect'));
    const out = formatOutput(makeResult({ issues }));
    expect(out).toContain('... +1');
  });

  it('15 nodes: shows first 6 then ... +9', () => {
    const nodes = Array.from({ length: 15 }, (_, i) => `cli/commands/cmd${i}`);
    const issues = nodes.map(n => makeCascadeIssue(n, 'my-aspect'));
    const out = formatOutput(makeResult({ issues }));
    expect(out).toContain('... +9');
  });
});

// ── 5. FAIL mixed errors ──────────────────────────────────────

describe('FAIL mixed errors', () => {
  it('per-error block shows code, node path, what on first line', () => {
    const issues = [
      makeError('source-drift', 'source files changed since last approve', '2 mapped files modified', 'yg approve --node cli/commands/approve', 'cli/commands/approve'),
    ];
    const out = formatOutput(makeResult({ issues, suggestedNext: 'yg approve --node cli/commands/approve' }));
    expect(out).toContain('drift');
    expect(out).toContain('cli/commands/approve');
    expect(out).toContain('Why:');
    expect(out).toContain('Fix:');
  });

  it('single Next: line driven by first error', () => {
    const issues = [
      makeError('source-drift', 'drift a', '', 'yg approve --node cli/a', 'cli/a'),
      makeError('source-drift', 'drift b', '', 'yg approve --node cli/b', 'cli/b'),
    ];
    const out = formatOutput(makeResult({
      issues,
      suggestedNext: 'yg approve --node cli/a',
    }));
    const nextMatches = out.match(/^Next:/gm);
    expect(nextMatches).toHaveLength(1);
    expect(out).toContain('Next: yg approve --node cli/a');
  });

  it('unmapped files rendered as error block', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-file',
      messageData: {
        what: '2 source files not covered by any node.\n  source/cli/src/foo.ts\n  source/cli/src/bar.ts',
        why: 'Files without graph coverage cannot be modified under the protocol.',
        next: 'yg owner --suggest <path>',
      },
      uncoveredFiles: ['source/cli/src/foo.ts', 'source/cli/src/bar.ts'],
      uncoveredCount: 2,
    };
    const out = formatOutput(makeResult({ issues: [issue], coveredFiles: 463, totalFiles: 465 }));
    expect(out).toContain('unmapped');
    expect(out).toContain('foo.ts');
    expect(out).toContain('bar.ts');
  });
});

// ── 6. FAIL with warnings ─────────────────────────────────────

describe('FAIL with warnings', () => {
  it('errors before warnings, single Next: from first error', () => {
    const issues = [
      makeError('source-drift', 'drift', 'files changed', 'yg approve --node cli/commands/approve', 'cli/commands/approve'),
      makeAdvisoryWarning('rate-limiting', 'cli/payments/handler'),
    ];
    const out = formatOutput(makeResult({
      issues,
      advisoryWarnings: 1,
      suggestedNext: 'yg approve --node cli/commands/approve',
    }));
    expect(out).toContain('Errors (1)');
    expect(out).toContain('Warnings (1)');
    const errIdx = out.indexOf('Errors');
    const warnIdx = out.indexOf('Warnings');
    expect(errIdx).toBeLessThan(warnIdx);
    const nextMatches = out.match(/^Next:/gm);
    expect(nextMatches).toHaveLength(1);
  });
});

// ── 7. Coverage variants ──────────────────────────────────────

describe('coverage variants', () => {
  it('100% coverage: X/Y files no percentage', () => {
    const out = formatOutput(makeResult({ coveredFiles: 465, totalFiles: 465 }));
    expect(out).toContain('465/465 files');
    expect(out).not.toMatch(/\d+%/);
  });

  it('<100% coverage: X/Y files (Z%)', () => {
    const out = formatOutput(makeResult({ coveredFiles: 462, totalFiles: 465 }));
    expect(out).toContain('462/465 files');
    expect(out).toMatch(/\d+%/);
    // 462/465 = 99.35% rounds to 99%
    expect(out).toContain('99%');
  });

  it('coverage percentage rounds to integer', () => {
    // 100/150 = 66.67% → 67%
    const out = formatOutput(makeResult({ coveredFiles: 100, totalFiles: 150 }));
    expect(out).toMatch(/67%/);
  });
});

// ── 8. Draft count ────────────────────────────────────────────

describe('draft count', () => {
  it('0 draft → no draft suffix', () => {
    const out = formatOutput(makeResult({ draftSkipped: 0 }));
    expect(out).not.toMatch(/· \d+ draft/);
  });

  it('1 draft → · 1 draft in header', () => {
    const out = formatOutput(makeResult({ draftSkipped: 1 }));
    expect(out).toContain('· 1 draft');
  });

  it('5 draft → · 5 draft in header', () => {
    const out = formatOutput(makeResult({ draftSkipped: 5 }));
    expect(out).toContain('· 5 draft');
  });
});

// ── 9. Metrics ordering ───────────────────────────────────────

describe('metrics ordering', () => {
  it('metrics appear in correct order: nodes · files · aspects · flows · draft', () => {
    const out = formatOutput(makeResult({ draftSkipped: 2 }));
    const line = out.trim().split('\n')[0];
    const nodesIdx = line.indexOf('nodes');
    const filesIdx = line.indexOf('files');
    const aspectsIdx = line.indexOf('aspects');
    const flowsIdx = line.indexOf('flows');
    const draftIdx = line.indexOf('draft');
    expect(nodesIdx).toBeLessThan(filesIdx);
    expect(filesIdx).toBeLessThan(aspectsIdx);
    expect(aspectsIdx).toBeLessThan(flowsIdx);
    expect(flowsIdx).toBeLessThan(draftIdx);
  });
});
