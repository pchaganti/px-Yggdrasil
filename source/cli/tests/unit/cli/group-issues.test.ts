import { describe, it, expect } from 'vitest';
import { groupIssues, CODE_ONLY_GROUP_CODES } from '../../../src/cli/group-issues.js';
import type { CheckIssue } from '../../../src/core/check.js';

function iss(p: Partial<CheckIssue>): CheckIssue {
  return {
    severity: 'error', code: 'unverified', rule: 'unverified',
    messageData: { what: 'w', why: 'shared-why', next: 'yg check --approve' },
    ...p,
  } as CheckIssue;
}

describe('groupIssues', () => {
  it('collapses same (code, aspectId) across nodes into ONE group', () => {
    const groups = groupIssues([
      iss({ aspectId: 'audit-logging', nodePath: 'b' }),
      iss({ aspectId: 'audit-logging', nodePath: 'a' }),
      iss({ aspectId: 'audit-logging', nodePath: 'c' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pairCount).toBe(3);
    expect(groups[0].nodeCount).toBe(3);
    expect(groups[0].members.map((m) => m.nodePath)).toEqual(['a', 'b', 'c']); // sorted
    expect(groups[0].sharedWhy).toBe('shared-why');
  });

  it('keeps different aspectIds as separate groups for non-unverified codes', () => {
    const groups = groupIssues([
      iss({ code: 'aspect-violation-enforced', aspectId: 'x', nodePath: 'a' }),
      iss({ code: 'aspect-violation-enforced', aspectId: 'y', nodePath: 'a' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('marks refusal codes as perMemberReason', () => {
    const [g] = groupIssues([
      iss({ code: 'aspect-violation-enforced', aspectId: 'x', nodePath: 'a' }),
    ]);
    expect(g.perMemberReason).toBe(true);
    expect(g.label).toBe('enforced');
  });

  // NEW: unverified issues with DIFFERENT aspectIds collapse into ONE group
  it('collapses unverified issues with DIFFERENT aspectIds into ONE group', () => {
    const groups = groupIssues([
      iss({ code: 'unverified', aspectId: 'audit-logging', nodePath: 'orders/handler' }),
      iss({ code: 'unverified', aspectId: 'command-exit-codes', nodePath: 'cli/commands/check' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pairCount).toBe(2);
    // The group spans multiple aspects — aspectId is undefined on the group
    expect(groups[0].aspectId).toBeUndefined();
    // Individual members still carry their own aspectIds
    const aspectIds = groups[0].members.map((m) => m.aspectId);
    expect(aspectIds).toContain('audit-logging');
    expect(aspectIds).toContain('command-exit-codes');
  });

  // NEW: CODE_ONLY_GROUP_CODES export check
  it('CODE_ONLY_GROUP_CODES includes "unverified"', () => {
    expect(CODE_ONLY_GROUP_CODES.has('unverified')).toBe(true);
  });

  // NEW: non-unverified codes with different aspectIds remain as separate groups
  it('prompt-too-large with two different aspectIds makes TWO groups', () => {
    const groups = groupIssues([
      iss({ code: 'prompt-too-large', aspectId: 'aspect-a', nodePath: 'node/a' }),
      iss({ code: 'prompt-too-large', aspectId: 'aspect-b', nodePath: 'node/b' }),
    ]);
    expect(groups).toHaveLength(2);
    // Each group retains its specific aspectId
    const ids = groups.map((g) => g.aspectId).sort();
    expect(ids).toEqual(['aspect-a', 'aspect-b']);
  });
});
