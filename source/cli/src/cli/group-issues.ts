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

/**
 * Issue codes that group by CODE ONLY — all instances collapse into a single
 * group regardless of aspectId. The shared why+fix renders once; the aspect
 * is shown on each body line (`- <node>  aspect '<id>'`) instead of the
 * group header.
 *
 * `unverified` is the primary case: editing one aspect previously produced
 * N near-identical group blocks (one per aspect) with the same why+fix text.
 * Now they collapse into one block, with each line annotating its aspect.
 */
export const CODE_ONLY_GROUP_CODES = new Set(['unverified']);

export function groupIssues(issues: CheckIssue[]): IssueGroup[] {
  const byKey = new Map<string, CheckIssue[]>();
  for (const i of issues) {
    const key = CODE_ONLY_GROUP_CODES.has(i.code)
      ? i.code
      : (i.aspectId !== undefined ? `${i.code} ${i.aspectId}` : i.code);
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
    // For code-only groups the aspectId spans multiple aspects — set to
    // undefined so the group header does NOT print `aspect '<id>'`.
    const isCodeOnly = CODE_ONLY_GROUP_CODES.has(rep.code);
    groups.push({
      code: rep.code,
      aspectId: isCodeOnly ? undefined : rep.aspectId,
      severity: rep.severity,
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
