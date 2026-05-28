import type { IssueMessage } from '../model/validation.js';
import type { AspectStatus } from '../model/graph.js';

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

export function impliesStatusInheritInvalidMessage(params: {
  implierId: string;
  impliedId: string;
  value: string;
  aspectDir: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.implierId}' implies aspect '${params.impliedId}' with status_inherit: '${params.value}' (not a valid value).`,
    why: 'status_inherit must be one of: strictest, own-default.',
    next: `Edit ${posixPath(params.aspectDir)}/yg-aspect.yaml. Use 'strictest' (default — implied aspect promotes to implier's status if higher) or 'own-default' (implied aspect keeps its own aspect-default).`,
  };
}

export function aspectStatusDowngradeMessage(params: {
  nodePath: string;
  aspectId: string;
  declared: AspectStatus;
  anchor: AspectStatus;
  origin: string;
}): IssueMessage {
  return {
    what: `Node '${params.nodePath}' attaches aspect '${params.aspectId}' with status '${params.declared}', but the aspect cascades onto this node with status '${params.anchor}' from ${params.origin}.`,
    why: 'An explicit attach-site status cannot relax (downgrade) what already cascades — that would silently weaken enforcement.',
    next: `Either remove the explicit status on this attach site (let the cascade win), or raise the cascading source if you actually want to weaken the rule everywhere. See: yg knowledge read aspect-status.`,
  };
}
