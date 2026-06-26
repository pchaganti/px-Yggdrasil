import { describe, it, expect } from 'vitest';
import { formatOutput, resolveTopValue, renderGroup } from '../../../src/cli/check.js';
import type { CheckView } from '../../../src/cli/check.js';
import { groupIssues } from '../../../src/cli/group-issues.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
  promptTooLargeMessage,
} from '../../../src/formatters/lock-issue-messages.js';

/** Strip ANSI color codes so block-line counting is deterministic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Count rendered issue BLOCKS — a block begins with two-space-indented
 *  "<label>  <node>  <what>" (or the compact "<label> (<n>)" unmapped block).
 *  Continuation lines (Why:/Fix:/indented detail) are NOT block starts. */
function countBlocks(out: string): number {
  const clean = stripAnsi(out);
  return clean
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l) && !/^ {2}(Why:|Fix:)/.test(l))
    .length;
}

/**
 * Unit tests for the `yg check` render layer (formatOutput / renderIssueBlock).
 * These exercise the rendering directly against constructed CheckResult objects
 * — no spawned binary, no build — so they pin the agent-facing OUTPUT contract:
 *   - refusal issues must render their FULL `what` (reviewer reason / violation
 *     list), not just line 1;
 *   - advisory warnings (aspect-violation AND unverified) must carry the
 *     "(advisory — not blocking)" hint and a next pointer.
 */

function baseResult(issues: CheckIssue[]): CheckResult {
  const hasError = issues.some((i) => i.severity === 'error');
  return {
    projectName: 'test',
    nodeCount: 1,
    nodeTypeCounts: new Map(),
    aspectCount: 1,
    flowCount: 0,
    coveredFiles: 0,
    totalFiles: 0,
    issues,
    suggestedNext: hasError ? 'yg check --approve' : null,
    advisoryWarnings: issues.filter((i) => i.code === 'aspect-violation-advisory').length,
    draftSkipped: 0,
  };
}

describe('check render — refusal detail (full what)', () => {
  it('renders grouped block with reviewer reason line for an enforced LLM refusal', () => {
    const reason =
      'The handler does not emit an audit-log entry on the failure branch.\n' +
      'Line 42: catch block returns without logging the rejected request.';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));

    // Grouped grammar: group header with label, pair/node counts, aspect id.
    expect(out).toContain("enforced  1 pairs  1 nodes  aspect 'audit-logging'");
    // perMemberReason: the first detail line of `what` (line 1) appears on the member.
    expect(out).toContain('Reviewer reason: The handler does not emit an audit-log entry on the failure branch.');
    // The three-exits Fix block must reach the agent — including the yg-suppress exit.
    expect(out).toContain('yg-suppress');
    // Member line for the node.
    expect(out).toContain('- orders/handler');
  });

  it('renders grouped block with violation header for an enforced det refusal', () => {
    const reason =
      'src/a.ts:10 — forbidden import of database client\n' +
      'src/b.ts:22 — forbidden import of database client';
    const issue: CheckIssue = {
      severity: 'error',
      code: 'aspect-violation-enforced',
      rule: 'aspect-violation-enforced',
      nodePath: 'ui/page',
      aspectId: 'ui-no-direct-db',
      messageData: detRefusedMessage({
        aspectId: 'ui-no-direct-db',
        unitKey: 'ui/page#ui-no-direct-db',
        reason,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));

    // Group header present.
    expect(out).toContain("enforced  1 pairs  1 nodes  aspect 'ui-no-direct-db'");
    // perMemberReason: what line 1 ('Violations:') appears on the member.
    expect(out).toContain('Violations:');
    // Fix line present.
    expect(out).toContain('Fix: Fix the listed violations');
    // Member line for the node.
    expect(out).toContain('- ui/page');
  });

  it('renders a grouped block for a prompt-too-large issue with Fix: remedies', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'prompt-too-large',
      rule: 'prompt-too-large',
      nodePath: 'big/node',
      aspectId: 'some-aspect',
      messageData: promptTooLargeMessage({
        aspectId: 'some-aspect',
        unitKey: 'big/node#some-aspect',
        tierName: 'standard',
        chars: 99999,
        limit: 40000,
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Group header present with correct label and aspect.
    expect(out).toContain("prompt-too-large  1 pairs  1 nodes  aspect 'some-aspect'");
    // The safety-ordered remedies from `next` still reach the agent.
    expect(out).toContain('Narrow scope.files');
    // Member line for the node.
    expect(out).toContain('- big/node');
  });
});

describe('check render — advisory warning hints', () => {
  it('renders a grouped warning block for an advisory aspect-violation warning with fix pointer', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason: 'missing audit entry',
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Grouped grammar: group header with advisory label and aspect.
    expect(out).toContain("advisory  1 pairs  1 nodes  aspect 'audit-logging'");
    // Reason appears in member detail (perMemberReason: true for aspect-violation-advisory).
    expect(out).toContain('missing audit entry');
    // Fix block must include the three-exits next.
    expect(out).toContain('yg-suppress');
  });

  it('renders a grouped warning block for an advisory unverified warning with Fix pointer', () => {
    const issue: CheckIssue = {
      severity: 'warning',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: unverifiedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
      }),
    };

    const out = stripAnsi(formatOutput(baseResult([issue])));
    // Grouped grammar: group header.
    expect(out).toContain("unverified (not yet reviewed)  1 pairs  1 nodes  aspect 'audit-logging'");
    // The next pointer must be present so the agent knows how to clear it.
    expect(out).toContain('yg check --approve');
  });

  it('does NOT add the advisory hint to an enforced (error-mode) unverified issue', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: unverifiedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
      }),
    };

    const out = formatOutput(baseResult([issue]));
    expect(out).not.toContain('(advisory — not blocking)');
  });
});

describe('check render — Next line surfacing', () => {
  /** A result whose only issue is an advisory aspect-violation warning — the
   *  warnings-only PASS case. computeSuggestedNext returns the warning's `next`
   *  (non-null) even though there are zero errors. */
  function warningsOnlyResult(): CheckResult {
    const advWarning: CheckIssue = {
      severity: 'warning',
      code: 'aspect-violation-advisory',
      rule: 'aspect-violation-advisory',
      nodePath: 'orders/handler',
      aspectId: 'audit-logging',
      messageData: llmRefusedMessage({
        aspectId: 'audit-logging',
        unitKey: 'orders/handler#audit-logging',
        reason: 'missing audit entry',
      }),
    };
    return {
      projectName: 'test',
      nodeCount: 1,
      nodeTypeCounts: new Map(),
      aspectCount: 1,
      flowCount: 0,
      coveredFiles: 0,
      totalFiles: 0,
      issues: [advWarning],
      // What computeSuggestedNext returns for a warnings-only run: the first
      // advisory aspect-violation warning's own `next`.
      suggestedNext: advWarning.messageData.next,
      advisoryWarnings: 1,
      draftSkipped: 0,
    };
  }

  it('renders the Next line on a warnings-only PASS (no errors, non-null suggestedNext)', () => {
    const out = formatOutput(warningsOnlyResult());
    // Still a PASS (warnings never fail the verdict)…
    expect(out).toContain('yg check: PASS');
    expect(out).toContain('1 warning');
    // …and the computed next-action is surfaced, not silently dropped.
    expect(out).toMatch(/\nNext: /);
  });

  it('omits the Next line on a fully-green run (no issues, null suggestedNext)', () => {
    const green: CheckResult = {
      ...warningsOnlyResult(),
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
    };
    const out = formatOutput(green);
    expect(out).toContain('yg check: PASS');
    // A clean run is self-evidently done — no invented green Next line.
    expect(out).not.toContain('Next:');
  });

  it('still renders the Next line on a failing run (errors present)', () => {
    const out = formatOutput(baseResult([
      {
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        nodePath: 'orders/handler',
        aspectId: 'audit-logging',
        messageData: unverifiedMessage({
          aspectId: 'audit-logging',
          unitKey: 'orders/handler#audit-logging',
        }),
      },
    ]));
    expect(out).toContain('yg check: FAIL');
    expect(out).toMatch(/\nNext: /);
  });
});

// ── Triage views: --top and --summary ──────────────────────

/** A four-error result mirroring the sample-project shape: two LLM unverified,
 *  one deterministic unverified, and one non-pair structural error (no
 *  pairKind) → the "other" bucket in --summary. */
function fourErrorResult(): CheckResult {
  const issues: CheckIssue[] = [
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'auth/auth-api',
      aspectId: 'requires-logging',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'requires-logging', unitKey: 'auth/auth-api#requires-logging' }),
    },
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/order-service',
      aspectId: 'requires-audit',
      pairKind: 'llm',
      messageData: unverifiedMessage({ aspectId: 'requires-audit', unitKey: 'orders/order-service#requires-audit' }),
    },
    {
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      nodePath: 'orders/order-service',
      aspectId: 'is-deterministic',
      pairKind: 'deterministic',
      messageData: unverifiedMessage({ aspectId: 'is-deterministic', unitKey: 'orders/order-service#is-deterministic' }),
    },
    {
      // Non-pair structural error — carries NO pairKind. Must be bucketed as
      // "other" in --summary so per-node totals reconcile with the header.
      severity: 'error',
      code: 'mapping-path-missing',
      rule: 'mapping-path-missing',
      nodePath: 'users/missing-service',
      messageData: {
        what: "Mapping path 'src/users/missing.service.ts' does not exist on disk.",
        why: 'A node mapping points at a file that is not present.',
        next: 'Create the file or fix the mapping entry.',
      },
    },
  ];
  return baseResult(issues);
}

describe('check render — --top view', () => {
  it('full view renders the Errors header with true count and every group', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'full' }));
    // The fourErrorResult has 3 unverified issues (each with a distinct aspectId)
    // + 1 mapping-path-missing → 4 groups total.
    expect(out).toContain('Errors (4) in 4 groups:');
    // Each group renders a header line starting with two spaces (matching countBlocks).
    expect(countBlocks(out)).toBe(4);
  });

  it('{kind:top,n:1} renders the true Errors(4) header, exactly one block, and the Next line', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 1 }));
    // Header keeps the TRUE total — a truncated view must never read as fewer errors.
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(1);
    expect(out).toMatch(/\nNext: /);
  });

  it('{kind:top,n:0} renders the true header, zero blocks, and still the single Next line', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 0 }));
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(0);
    expect(out).toMatch(/\nNext: /);
    // Exactly one Next line, nothing more.
    expect((out.match(/\nNext: /g) ?? []).length).toBe(1);
  });

  it('{kind:top,n:99} renders all blocks without crashing (n exceeds issue count)', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 99 }));
    expect(out).toContain('Errors (4):');
    expect(countBlocks(out)).toBe(4);
  });

  it('top view renders the highest-priority block first (unverified before structural)', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'top', n: 1 }));
    // unverified outranks mapping-path-missing in the §6 cascade.
    expect(out).toContain('unverified');
    expect(out).not.toContain('mapping-path-missing');
  });
});

describe('check render — --summary view', () => {
  it('renders per-node det/LLM split, an "other" bucket, no Why: lines, and the true header', () => {
    const out = stripAnsi(formatOutput(fourErrorResult(), { kind: 'summary' }));
    // True header count preserved.
    expect(out).toContain('Errors (4):');
    // auth/auth-api: 1 LLM unverified.
    expect(out).toMatch(/auth\/auth-api\s+1 unverified \(0 deterministic-free, 1 LLM\)/);
    // orders/order-service: 1 LLM + 1 deterministic.
    expect(out).toMatch(/orders\/order-service\s+2 unverified \(1 deterministic-free, 1 LLM\)/);
    // The non-pair structural error lands in the per-node "other" bucket.
    expect(out).toMatch(/users\/missing-service\s+.*1 other/);
    // No per-issue blocks: no Why:/Fix: lines.
    expect(out).not.toContain('Why:');
    expect(out).not.toContain('Fix:');
    // Next line still present.
    expect(out).toMatch(/\nNext: /);
  });

  it('on a green result prints only the PASS header — no rows', () => {
    const green: CheckResult = {
      ...fourErrorResult(),
      issues: [],
      suggestedNext: null,
      advisoryWarnings: 0,
    };
    const out = stripAnsi(formatOutput(green, { kind: 'summary' }));
    expect(out).toContain('yg check: PASS');
    // No per-node rows, no Errors header.
    expect(out).not.toContain('unverified');
    expect(out).not.toContain('Next:');
  });

  // REGRESSION (v5.2.0): a non-pair coverage issue buckets as ONE "other" per
  // issue OBJECT, NOT per uncoveredCount. The header Errors(N) counts each
  // aggregate coverage issue (one unmapped-files issue with uncoveredCount:7) as
  // ONE; the per-node "other" total must reconcile with it. Before the fix the
  // summary added `issue.uncoveredCount` (7), over-counting against the header.
  it('a single unmapped-files issue (uncoveredCount:7) renders "1 other", reconciling with Errors(1)', () => {
    const issue: CheckIssue = {
      severity: 'error',
      code: 'unmapped-files',
      rule: 'unmapped-files',
      nodePath: 'lib/widgets',
      uncoveredCount: 7,
      // No pairKind — this is a structural/coverage issue, not a verification pair.
      messageData: {
        what: '7 files under this node are not mapped to any node.',
        why: 'Unmapped files are not verified by any aspect.',
        next: 'Add the files to a node mapping or create a node.',
      },
    };

    const out = stripAnsi(formatOutput(baseResult([issue]), { kind: 'summary' }));
    // Header counts the issue OBJECT once.
    expect(out).toContain('Errors (1):');
    // Per-node "other" bucket matches the header — ONE, not the 7 uncovered files.
    expect(out).toMatch(/lib\/widgets\s+.*1 other/);
    expect(out).not.toContain('7 other');
  });
});

describe('check render — renderGroup', () => {
  it('renders ONE grouped block for an aspect failing on many nodes', () => {
    const issues: CheckIssue[] = ['a', 'b', 'c'].map((n) => ({
      severity: 'error',
      code: 'unverified',
      rule: 'unverified',
      aspectId: 'audit-logging',
      pairKind: 'llm',
      nodePath: n,
      messageData: unverifiedMessage({ aspectId: 'audit-logging', unitKey: n }),
    } as CheckIssue));
    const [g] = groupIssues(issues);
    const lines: string[] = [];
    renderGroup(g, lines, { isTTY: false });
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain("unverified (not yet reviewed)  3 pairs  3 nodes  aspect 'audit-logging'");
    expect(out).toContain('- a');
    expect(out).toContain('- b');
    expect((out.match(/Fix: yg check --approve/g) ?? []).length).toBe(1);
  });
});

describe('check render — grouped full view (task 1.3)', () => {
  it('header counts reconcile: 2 unverified(x) + 1 refused(y) → Errors (3) in 2 groups:', () => {
    const issues: CheckIssue[] = [
      ...['a', 'b'].map((n) => ({
        severity: 'error',
        code: 'unverified',
        rule: 'unverified',
        aspectId: 'x',
        pairKind: 'llm',
        nodePath: n,
        messageData: unverifiedMessage({ aspectId: 'x', unitKey: n }),
      } as CheckIssue)),
      {
        severity: 'error',
        code: 'aspect-violation-enforced',
        rule: 'aspect-violation-enforced',
        aspectId: 'y',
        pairKind: 'llm',
        nodePath: 'a',
        messageData: llmRefusedMessage({ aspectId: 'y', unitKey: 'a', reason: 'r' }),
      } as CheckIssue,
    ];
    const out = stripAnsi(formatOutput(baseResult(issues)));
    expect(out).toContain('Errors (3) in 2 groups:');
  });
});

describe('resolveTopValue', () => {
  const cases: Array<[boolean | string | undefined, number | null]> = [
    [undefined, 0],
    [true, 0],        // bare --top → suggestedNext-only
    ['1', 1],
    ['5', 5],
    ['99', 99],
    ['0', null],      // explicit "0" is garbage — bare --top is the zero path
    ['-2', null],
    ['abc', null],
    ['1.5', null],
    ['', null],
    [false, null],
  ];
  for (const [raw, expected] of cases) {
    it(`maps ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(resolveTopValue(raw)).toBe(expected);
    });
  }

  it('confirms a CheckView union shape is accepted by formatOutput', () => {
    const views: CheckView[] = [{ kind: 'full' }, { kind: 'top', n: 2 }, { kind: 'summary' }];
    for (const v of views) {
      expect(() => formatOutput(fourErrorResult(), v)).not.toThrow();
    }
  });
});
