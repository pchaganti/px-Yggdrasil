/**
 * Agent-facing what/why/next messages for the relation-conformance check code
 * (`relation-undeclared-dependency`). Minimal in Phase 0 — Phase 12 enriches the
 * text (path hints, the declare-vs-remove decision tree). Structured
 * `IssueMessage` objects only; the check renderer (cli/check.ts) presents them,
 * exactly like every other lock/structural issue.
 */

import type { IssueMessage } from '../model/validation.js';

/** Refused: the node has undeclared dependencies (reason is the rendered violation list). */
export function relationRefusedMessage(nodeId: string, reason: string | undefined): IssueMessage {
  return {
    what: `Node '${nodeId}' has undeclared dependencies on other nodes:\n${reason ?? ''}`.trimEnd(),
    why: 'A dependency on another component must be a sanctioned, declared relation. Undeclared edges erode the architecture allow-list of who may depend on whom.',
    next: `Declare the relation(s) in the node's yg-node.yaml (choose an allowed type), or remove the dependency if it is not legitimate.`,
  };
}

/** Unverified: inputs changed since the last approval. */
export function relationUnverifiedMessage(nodeId: string): IssueMessage {
  return {
    what: `Relation conformance for node '${nodeId}' is unverified — its source, relations, or a dependency target changed since the last approval.`,
    why: 'A relation verdict is valid only while its inputs are unchanged; an input changed, so the verdict must be recomputed before it can be trusted.',
    next: 'Run: yg check --approve',
  };
}
