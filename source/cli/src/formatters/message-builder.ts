import type { IssueMessage } from '../model/validation.js';

export type { IssueMessage };

/**
 * Build a structured issue message.
 * Single newline between sections — no blank lines.
 * Indentation is NOT added here; the caller handles presentation context.
 */
export function buildIssueMessage(msg: IssueMessage): string {
  return `${msg.what}\n${msg.why}\n${msg.next}`;
}
