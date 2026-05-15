// ============================================================
// Validation
// ============================================================

import type { IssueMessage } from '../formatters/message-builder.js';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code?: string;
  rule: string;
  message: string;
  messageData?: IssueMessage;
  nodePath?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  nodesScanned: number;
}
