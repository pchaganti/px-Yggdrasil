import type { IssueMessage } from '../../model/validation.js';

export function issueMsg(data: IssueMessage): { messageData: IssueMessage } {
  return { messageData: data };
}
