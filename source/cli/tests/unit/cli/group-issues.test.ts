import { describe, it, expect } from 'vitest';
import { groupIssues } from '../../../src/cli/group-issues.js';
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

  it('keeps different aspectIds as separate groups', () => {
    const groups = groupIssues([
      iss({ aspectId: 'x', nodePath: 'a' }),
      iss({ aspectId: 'y', nodePath: 'a' }),
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
});
