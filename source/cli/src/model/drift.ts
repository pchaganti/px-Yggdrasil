import type { IssueMessage } from './validation.js';

// ============================================================
// LLM Verification Results (shared by drift and LLM subsystems)
// ============================================================

/** Cached LLM aspect verification result */
export interface AspectVerificationResult {
  satisfied: boolean;
  reason: string;
  /** Discriminator: codeViolation = real code issue; provider = infra/API error; checkRuntime = deterministic check threw */
  errorSource: 'codeViolation' | 'provider' | 'checkRuntime';
}

/**
 * Per-aspect verdict recorded in the drift baseline.
 *
 * Captured at approve time and persisted EVEN when the overall node action
 * is 'refused'. This lets `yg check` render per-aspect refused state without
 * losing the baseline hash needed for drift tracking.
 */
export interface AspectVerdict {
  verdict: 'approved' | 'refused';
  /** Present when verdict is 'refused' — mirrors AspectVerificationResult.reason */
  reason?: string;
  /**
   * Source of an aspect's refusal.
   *  - 'codeViolation' — source code did not satisfy the aspect's content (LLM judgement)
   *    or violated a structural rule (AST/structure runner).
   *  - 'provider'      — LLM provider call itself failed.
   *  - 'checkRuntime'  — runtime crash inside a deterministic runner's check.mjs.
   *    This tag is the generic "non-LLM runner crash" discriminator,
   *    persisted per-aspect in baseline AspectVerdict.errorSource.
   */
  errorSource?: 'codeViolation' | 'provider' | 'checkRuntime';
}

// ============================================================
// Drift
// ============================================================

/** Category of a drifted file — source (mapping) or graph (.yggdrasil/) */
export type DriftCategory = 'source' | 'graph';

/**
 * Which layer of the context package brought this file into tracking.
 *
 * The 'check-touched' token marks files that a deterministic aspect
 * read during its run; it is serialized into baseline .drift-state/*.json.
 */
export type TrackedFileLayer = 'hierarchy' | 'aspects' | 'relational' | 'flows' | 'source' | 'check-touched';

/** Per-file drift detail */
export interface DriftFileChange {
  filePath: string;
  category: DriftCategory;
}

export type NodeLifecycleState = 'ok' | 'missing' | 'unapproved';

/**
 * The current on-disk drift-state format version. Stamped on every baseline at
 * write time and validated at read time (io/drift-state-store.ts). A baseline
 * with an absent or unrecognized schemaVersion predates this format and is NOT
 * parsed by the single-format runtime — it is the migration's job to re-key it
 * losslessly (core/drift-state-rekey.ts). The read store rejects such baselines
 * with an upgrade-pointing error (the second net behind the graph-loader
 * version gate).
 */
export const DRIFT_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Per-aspect identity captured in the typed baseline. Each field is a sha256
 * hex digest of a canonically-serialized aspect-definition slice. Folded into
 * the node's canonical drift hash so a change to any of them cascades.
 */
export interface AspectIdentity {
  /**
   * Aspect-definition hash — EXCLUDES `status`, so an advisory↔enforced flip
   * does NOT drift (the verdict carries forward); a draft↔non-draft transition
   * is surfaced separately via aspect-newly-active.
   */
  meta: string;
  /**
   * Resolved reviewer-tier identity hash. Present for LLM aspects only.
   * EXCLUDES `api_key` (a secret, not part of the reviewer config identity).
   */
  tier?: string;
  /**
   * Per-deterministic-aspect touched files captured at the last
   * enforced/advisory approve. OPTIONAL — this is legitimate DOMAIN
   * optionality, NOT backward-compat:
   *   - absent = no deterministic aspect recorded a touched-file set (cold start)
   *   - preserved across draft toggle (clearDraftAspectsFromDriftState does NOT clear it)
   * Schema: { [repoRelPosixPath]: sha256Hex }
   */
  checkTouched?: Record<string, string>;
}

/**
 * A typed identity-element change (a piece of the node's upstream identity that
 * is folded into the canonical hash but is NOT a real file on disk). Replaces
 * the former synthetic `<kind>:<id>` string keys. Carried on a CascadeCause so
 * attribution (`--aspect` batch selection, per-aspect re-review) is typed
 * rather than parsed out of a path string.
 */
export type IdentityCause =
  | { kind: 'ownSubset'; nodePath: string }
  | { kind: 'aspectMeta'; aspectId: string }
  | { kind: 'tier'; aspectId: string }
  | { kind: 'checkTouchedSet'; aspectId: string }
  | { kind: 'port'; targetPath: string };

/**
 * Typed upstream-identity slice of a baseline. Replaces the former synthetic
 * string keys (own-subset:/aspect-meta:/tier-identity:/check-touched:/
 * port-aspects:) that used to be stuffed into `files`. Folded into the
 * canonical drift hash via a stable, sorted serialization.
 */
export interface DriftIdentity {
  /** Hash of the node's own aspect-relevant yg-node.yaml subset (type/aspects/relations/ports). */
  ownSubset: string;
  /** Per-dependency scoped port-aspect set hashes (channel 6). Keyed by target node path. */
  ports: Record<string, string>;
  /** Per-effective-aspect identity. Keyed by aspect id. */
  aspects: Record<string, AspectIdentity>;
}

export interface DriftNodeState {
  /** On-disk format version. Always DRIFT_STATE_SCHEMA_VERSION for baselines written by this CLI. */
  schemaVersion: typeof DRIFT_STATE_SCHEMA_VERSION;
  hash: string;
  files: Record<string, string>;  // REAL source/graph file paths → sha256 hex — NO synthetic keys
  mtimes?: Record<string, number>; // path → mtime in ms — perf fast-path; NEVER folded into the canonical hash
  /** Typed upstream identity — folded into the canonical hash. */
  identity: DriftIdentity;
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
  /**
   * Per-aspect verdicts at last approve time. REQUIRED (may be `{}`).
   *
   * Recorded for every non-draft effective aspect that the reviewer evaluated.
   * Persisted on BOTH approved and refused branches so `yg check` can render
   * per-aspect refused state without re-running the reviewer.
   */
  aspectVerdicts: Record<string, AspectVerdict>;
}

/** Upstream change with type annotation for CLI messages */
export interface AnnotatedChange {
  filePath: string;
  /** Human-readable annotation, e.g. "aspect content", "dependency metadata", "flow description", "parent metadata" */
  annotation: string;
  /**
   * Present when this upstream change is a typed identity-element change (not a
   * real file). Carried so per-aspect re-review selection (selectDriftedAspects)
   * can attribute the change to its owning aspect by typed kind rather than by
   * parsing the filePath display token.
   */
  identity?: IdentityCause;
  /**
   * For a CROSS-node check-touched real-file content change: the deterministic
   * aspect(s) whose stored read-set contains this path. Set from the stored
   * typed identity so per-aspect attribution needs no baseline re-read.
   */
  attributedAspectIds?: string[];
}

/** Result of approveNode() — what happened and why */
export interface ApproveResult {
  action: 'approved' | 'initial' | 'refused' | 'no-change';
  previousHash?: string;
  currentHash: string;
  refuseReasonData?: IssueMessage;
  aspectViolations?: Array<{ aspectId: string; reason: string; errorSource: 'codeViolation' | 'provider' | 'checkRuntime' }>;
  changedSource?: string[];
  changedUpstream?: AnnotatedChange[];
  gcPaths?: string[];
  /** Drift state to persist — caller writes after LLM verification passes */
  pendingDriftState?: { nodePath: string; state: DriftNodeState };
}

/** Map: node-path → DriftNodeState. */
export type DriftState = Record<string, DriftNodeState>;


