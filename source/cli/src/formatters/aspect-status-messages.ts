import type { IssueMessage } from '../model/validation.js';

function posixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function aspectStatusInvalidMessage(params: {
  aspectId: string;
  value: string;
  aspectDir: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' declares status: '${params.value}' (not a valid value).`,
    why: 'Status must be one of: draft, advisory, enforced.',
    next: `Edit ${posixPath(params.aspectDir)}/yg-aspect.yaml and set status to one of the three valid values. See: yg knowledge read aspect-status.`,
  };
}
