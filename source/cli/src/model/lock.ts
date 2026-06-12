export const LOCK_FORMAT_VERSION = 1;
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

export interface LockFile {
  version: number; // LOCK_FORMAT_VERSION
  verdicts: Record<string, Record<string, VerdictEntry>>; // aspectId → unitKey → entry
  nodes: Record<string, LockNodeEntry>; // nodePath → per-node facts
}

/** 'node:<model-relative path>' | 'file:<repo-relative POSIX path>' */
export type UnitKey = string;
export const nodeUnit = (nodePath: string): UnitKey => `node:${nodePath}`;
export const fileUnit = (repoRelPosix: string): UnitKey => `file:${repoRelPosix}`;
