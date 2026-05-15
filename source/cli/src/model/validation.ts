// ============================================================
// Validation
// ============================================================

export type IssueSeverity = 'error' | 'warning';

export interface IssueMessage {
  /** What happened — facts, one line or short block */
  what: string;
  /** Why it's a problem — context for the agent */
  why: string;
  /** Concrete command or instruction to resolve */
  next: string;
}

export interface ValidationIssue {
  severity: IssueSeverity;
  code?: string;
  rule: string;
  messageData: IssueMessage;
  nodePath?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  nodesScanned: number;
}
