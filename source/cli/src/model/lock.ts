export const LOCK_FORMAT_VERSION = 2;
export const LOCK_FILE_NAME = 'yg-lock.json';

export type Verdict = 'approved' | 'refused';

export interface VerdictEntry {
  verdict: Verdict;
  /** inputHash per spec §3.1 — folds the verdict token. */
  hash: string;
  /** refused only: reviewer violation report (LLM) or rendered Violation[] (deterministic). */
  reason?: string;
  /** deterministic only: sorted [observationKey, observationHash] pairs for
   *  OUT-OF-SUBJECT observations (read:/list:/exists:/graph: keys, spec §3.1). */
  touched?: Array<[string, string]>;
}

export interface LockNodeEntry {
  /** Source fingerprint: sha256 fold over sorted [path, sha256(bytes)] of ALL mapped files
   *  (child carve-out applied, binaries included). Absent until first positive closure. */
  source?: string;
  /** Append-only log baseline (validateAppendOnly semantics, unchanged). */
  log?: { last_entry_datetime: string; prefix_hash: string };
}

/**
 * Per-dependency resolution outcome stored as relation evidence. Structurally
 * identical to `Outcome` in relations/fingerprint.ts (kept independent here so
 * model/ does not import from the higher relations/ layer).
 */
export type RelationOutcome =
  | { ownerNode: string; resolvedFile: string; resolvedFileHash: string; basis: string }
  | { external: true }
  | { missing: true };

/** One detected dependency's evidence. Mirrors `DepOutcome` in relations/fingerprint.ts. */
export interface RelationDepOutcome {
  fromFile: string;
  line: number;
  hintKey: string;
  outcome: RelationOutcome;
}

/**
 * The fingerprint inputs the relation pass observed for one node — stored so
 * plain `yg check` can re-validate the verdict WITHOUT re-parsing (hashing only;
 * tree-sitter is reserved for `--approve`). Structurally identical to
 * `FingerprintInput` in relations/fingerprint.ts so a `FingerprintInput` is
 * assignable to it. Producer pre-sorts the arrays for canonical serialization.
 */
export interface RelationEvidence {
  /** [path, contentHash] of this node's mapped files (sorted by path). */
  sources: Array<[string, string]>;
  /** hash of this node's declared relations. */
  relations: string;
  /** every detected dependency (resolved or not), sorted by fromFile\0line\0hintKey. */
  outcomes: RelationDepOutcome[];
  /** [language, extractorVersionTag] (sorted by language). */
  grammarVersions: Array<[string, string]>;
  /** hash over the symbol-language source-set identity. */
  indexIdentity: string;
}

/** A relation-conformance verdict for one node. Lives in its own lock section,
 *  NOT under `verdicts` (which is aspect-keyed). */
export interface RelationVerdict {
  verdict: Verdict;                 // 'approved' | 'refused'
  /** Self-contained fingerprint hash (see relations/fingerprint.ts). */
  fingerprint: string;
  /** refused only: rendered list of undeclared dependencies (one line each). */
  reason?: string;
  /** Fingerprint inputs the pass observed — drives parse-free re-validation. */
  evidence: RelationEvidence;
}

export interface LockFile {
  version: number; // LOCK_FORMAT_VERSION
  verdicts: Record<string, Record<string, VerdictEntry>>; // aspectId → unitKey → entry
  nodes: Record<string, LockNodeEntry>; // nodePath → per-node facts
  /** node unit key → relation verdict. */
  relation_verdicts: Record<string, RelationVerdict>;
}

/** 'node:<model-relative path>' | 'file:<repo-relative POSIX path>' */
export type UnitKey = string;
export const nodeUnit = (nodePath: string): UnitKey => `node:${nodePath}`;
export const fileUnit = (repoRelPosix: string): UnitKey => `file:${repoRelPosix}`;
