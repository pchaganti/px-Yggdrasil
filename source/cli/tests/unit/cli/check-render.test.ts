import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/cli/check.js';
import type { CheckResult, CheckIssue } from '../../../src/core/check.js';
import {
  llmRefusedMessage,
  detRefusedMessage,
  unverifiedMessage,
  promptTooLargeMessage,
} from '../../../src/formatters/lock-issue-messages.js';

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
  it('renders the FULL multi-line reviewer reason for an enforced LLM refusal', () => {
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

    const out = formatOutput(baseResult([issue]));

    // The reviewer reason — the actionable detail living AFTER line 1 of `what`
    // — must appear in plain `yg check`, not be truncated away.
    expect(out).toContain('The handler does not emit an audit-log entry on the failure branch.');
    expect(out).toContain('Line 42: catch block returns without logging the rejected request.');
    // The cached-verdict marker (line 1 summary) must still be present.
    expect(out).toContain('cached verdict');
    // The three-exits next instruction must also reach the agent in full.
    expect(out).toContain('yg-suppress');
  });

  it('renders the FULL deterministic violation list for an enforced det refusal', () => {
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

    const out = formatOutput(baseResult([issue]));

    expect(out).toContain('src/a.ts:10 — forbidden import of database client');
    expect(out).toContain('src/b.ts:22 — forbidden import of database client');
  });

  it('keeps the terse one-line `what` for a non-refusal issue (prompt-too-large)', () => {
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

    const out = formatOutput(baseResult([issue]));
    // The header (line 1 of what) is present…
    expect(out).toContain('over the');
    // …and the safety-ordered remedies from `next` still reach the agent.
    expect(out).toContain('Narrow scope.files');
  });
});

describe('check render — advisory warning hints', () => {
  it('adds "(advisory — not blocking)" to an advisory aspect-violation warning', () => {
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

    const out = formatOutput(baseResult([issue]));
    expect(out).toContain('(advisory — not blocking)');
    // Full reason still rendered for advisory refusals too.
    expect(out).toContain('missing audit entry');
  });

  it('adds "(advisory — not blocking)" and a next pointer to an advisory unverified warning', () => {
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

    const out = formatOutput(baseResult([issue]));
    expect(out).toContain('(advisory — not blocking)');
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
