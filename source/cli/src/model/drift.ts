import type { IssueMessage } from './validation.js';

// ============================================================
// LLM Verification Results (shared by drift and LLM subsystems)
// ============================================================

/** Cached LLM aspect verification result */
export interface AspectVerificationResult {
  satisfied: boolean;
  reason: string;
  /** @deprecated Use errorSource instead */
  providerError?: boolean;
  /** Discriminator: codeViolation = real code issue; provider = infra/API error; astRuntime = AST check threw */
  errorSource?: 'codeViolation' | 'provider' | 'astRuntime';
}

// ============================================================
// Drift
// ============================================================

/** Category of a drifted file — source (mapping) or graph (.yggdrasil/) */
export type DriftCategory = 'source' | 'graph';

/** Which layer of the context package brought this file into tracking */
export type TrackedFileLayer = 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source';

/** Per-file drift detail */
export interface DriftFileChange {
  filePath: string;
  category: DriftCategory;
}

export type NodeLifecycleState = 'ok' | 'missing' | 'unapproved';

export interface DriftNodeState {
  hash: string;
  files: Record<string, string>;  // path → sha256 hex — now required, not optional
  mtimes?: Record<string, number>; // path → mtime in ms — for mtime-based drift optimization
  /**
   * Log baseline — present only when log.md exists and last successful approve
   * captured at least one entry. Drives append-only integrity verification.
   */
  log?: {
    /** ISO 8601 UTC with millisecond precision, e.g. "2026-05-11T14:23:00.123Z" */
    last_entry_datetime: string;
    /** sha256 hex of bytes [0..offsetEnd of boundary entry) */
    prefix_hash: string;
  };
}

/** Upstream change with type annotation for CLI messages */
export interface AnnotatedChange {
  filePath: string;
  /** Human-readable annotation, e.g. "aspect content", "dependency metadata", "flow description", "parent metadata" */
  annotation: string;
}

/** Result of approveNode() — what happened and why */
export interface ApproveResult {
  action: 'approved' | 'initial' | 'refused' | 'no-change';
  previousHash?: string;
  currentHash: string;
  refuseReasonData?: IssueMessage;
  aspectViolations?: Array<{ aspectId: string; reason: string }>;
  changedSource?: string[];
  changedUpstream?: AnnotatedChange[];
  gcPaths?: string[];
  /** Drift state to persist — caller writes after LLM verification passes */
  pendingDriftState?: { nodePath: string; state: DriftNodeState };
}

/** Map: node-path → DriftNodeState. */
export type DriftState = Record<string, DriftNodeState>;


