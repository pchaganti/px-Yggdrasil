import type { CheckIssue } from '../core/check.js';
import { getIssueLabel, issuePriorityRank, FULL_WHAT_CODES } from './check.js';

export interface IssueGroup {
  code: string;
  aspectId?: string;
  severity: 'error' | 'warning';
  label: string;
  pairCount: number;
  nodeCount: number;
  sharedWhy: string;
  sharedNext: string;
  perMemberReason: boolean;
  members: CheckIssue[];
}

export function groupIssues(issues: CheckIssue[]): IssueGroup[] {
  const byKey = new Map<string, CheckIssue[]>();
  for (const i of issues) {
    const key = i.aspectId ? `${i.code} ${i.aspectId}` : i.code;
    const arr = byKey.get(key) ?? [];
    arr.push(i);
    byKey.set(key, arr);
  }
  const groups: IssueGroup[] = [];
  for (const members of byKey.values()) {
    const sorted = [...members].sort((a, b) =>
      (a.nodePath ?? '').localeCompare(b.nodePath ?? '', 'en'));
    const rep = sorted[0];
    const nodes = new Set(sorted.map((m) => m.nodePath ?? ''));
    groups.push({
      code: rep.code,
      aspectId: rep.aspectId,
      severity: rep.severity as 'error' | 'warning',
      label: getIssueLabel(rep),
      pairCount: sorted.length,
      nodeCount: nodes.size,
      sharedWhy: rep.messageData.why,
      sharedNext: rep.messageData.next,
      perMemberReason: FULL_WHAT_CODES.has(rep.code),
      members: sorted,
    });
  }
  groups.sort((a, b) => {
    const ra = issuePriorityRank(a.members[0]);
    const rb = issuePriorityRank(b.members[0]);
    if (ra !== rb) return ra - rb;
    if (a.label !== b.label) return a.label.localeCompare(b.label, 'en');
    return (a.aspectId ?? '').localeCompare(b.aspectId ?? '', 'en');
  });
  return groups;
}
