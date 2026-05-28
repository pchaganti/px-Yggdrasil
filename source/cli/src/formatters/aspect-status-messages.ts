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
    what: `Node '${posixPath(params.nodePath)}' attaches aspect '${params.aspectId}' with status '${params.declared}', but the aspect cascades onto this node with status '${params.anchor}' from ${params.origin}.`,
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
    what: `Aspect '${params.aspectId}' resolves to effective status 'draft' on node '${posixPath(params.nodePath)}' (overridden by ${params.origin}). Reviewer skipped on this node.`,
    why: `Other nodes where ${params.aspectId} is non-draft are unaffected.`,
    next: `To activate ${params.aspectId} on ${posixPath(params.nodePath)}, remove the draft override on ${params.origin}, or raise its effective status via another channel.`,
  };
}

/**
 * `yg approve --node Y` where every effective aspect on Y resolves to 'draft'.
 * Reviewer is skipped entirely on this node — no baseline written, no drift
 * tracked. Friendly message points the agent at how to activate an aspect.
 */
export function approveNodeAllDraftMessage(params: { nodePath: string }): IssueMessage {
  return {
    what: `Every effective aspect on node '${posixPath(params.nodePath)}' has status 'draft'. Reviewer skipped.`,
    why: 'Draft aspects are dormant; no baseline written, no drift tracked.',
    next: `Promote at least one effective aspect to 'advisory' or 'enforced' to enable approve on this node.`,
  };
}

/**
 * A non-draft effective aspect has no baseline verdict for this node. Emitted
 * by `yg check` when an aspect was flipped from draft -> advisory/enforced, when
 * a new attach activates a previously inactive aspect, or when a fresh aspect
 * is authored. Always renders as error so the agent re-approves before the
 * cycle continues -- advisory status only changes how a recorded verdict
 * renders, not whether an initial verdict is required.
 */
export function aspectNewlyActiveMessage(params: {
  aspectId: string;
  nodePath: string;
  status: 'advisory' | 'enforced';
}): IssueMessage {
  return {
    what: `Aspect '${params.aspectId}' is effective on node '${posixPath(params.nodePath)}' with status '${params.status}', but no reviewer baseline exists yet.`,
    why: `The reviewer has not judged this node against this aspect. A status flip from 'draft' to '${params.status}', a new attach, or a freshly authored aspect produces this state. Advisory status does not skip this step — every active aspect needs an initial verdict before yg check can render its result. Status only affects how the verdict renders later.`,
    next: `yg log add --node ${posixPath(params.nodePath)} --reason "..." && yg approve --node ${posixPath(params.nodePath)}`,
  };
}

/**
 * Baseline records the reviewer refused this aspect on this node AND the
 * aspect's effective status here is 'enforced'. Renders as error and blocks
 * `yg check`.
 */
export function aspectViolationEnforcedMessage(params: {
  aspectId: string;
  nodePath: string;
  reason: string;
}): IssueMessage {
  return {
    what: `Node '${posixPath(params.nodePath)}' fails enforced aspect '${params.aspectId}'. Reviewer reason: ${params.reason}.`,
    why: 'Enforced aspects block yg check. Fix the violation or change the rule.',
    next: `Read .yggdrasil/aspects/${params.aspectId}/content.md, fix the code, then yg approve --node ${posixPath(params.nodePath)}. Alternatives: change the aspect content, demote the aspect to advisory (see knowledge), or apply yg-suppress with a documented reason (user must approve).`,
  };
}

/**
 * Baseline records the reviewer refused this aspect on this node AND the
 * aspect's effective status here is 'advisory'. Renders as warning -- the
 * violation is recorded but does not block `yg check`.
 */
export function aspectViolationAdvisoryMessage(params: {
  aspectId: string;
  nodePath: string;
  reason: string;
}): IssueMessage {
  return {
    what: `Node '${posixPath(params.nodePath)}' fails advisory aspect '${params.aspectId}'. Reviewer reason: ${params.reason}.`,
    why: 'Advisory aspects render as warning — they do not block yg check, but the violation is recorded.',
    next: 'Optional: address the violation (see aspect-violation-enforced options) or accept the warning as known state.',
  };
}
