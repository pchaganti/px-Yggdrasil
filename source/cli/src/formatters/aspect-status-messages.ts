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

/**
 * Scenario A: `yg approve --aspect X` where X's aspect-default status is 'draft'.
 * No node could ever raise a draft-default aspect to non-draft via cascade
 * (draft is the floor of the lattice), so the entire batch is a no-op.
 */
export function approveAspectDraftScenarioAMessage(params: { aspectId: string }): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' has default status 'draft' — reviewer skipped on every node.`,
    why: 'Draft aspects are dormant; no baseline written, no drift tracked.',
    next: `Promote to 'advisory' or 'enforced' in .yggdrasil/aspects/${params.aspectId}/yg-aspect.yaml to activate.`,
  };
}

/**
 * Scenario B: `yg approve --aspect X` where X is non-draft by aspect-default but
 * resolves to effective 'draft' on a specific node (every cascading channel
 * overrides it down). Other nodes where X remains non-draft are still verified.
 */
export function approveAspectDraftScenarioBMessage(params: {
  aspectId: string;
  nodePath: string;
  origin: string;
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' resolves to effective status 'draft' on node '${params.nodePath}' (overridden by ${params.origin}). Reviewer skipped on this node.`,
    why: `Other nodes where ${params.aspectId} is non-draft are unaffected.`,
    next: `To activate ${params.aspectId} on ${params.nodePath}, remove the draft override on ${params.origin}, or raise its effective status via another channel.`,
  };
}
