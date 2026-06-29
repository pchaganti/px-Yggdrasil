// =============================================================================
// E2E TEST HELPER — read the committed lock TRIAD off disk, public-surface only.
//
// The e2e suites drive the real CLI binary and then assert on the verification
// state it persisted. That state lives in the 5.1.0 lock triad under a project's
// `.yggdrasil/` directory:
//
//   - yg-lock.nondeterministic.json (committed)  → LLM verdicts
//   - yg-lock.logs.json             (committed)  → the `nodes` section
//                                                  (per-node source fingerprint
//                                                   + log baseline)
//   - .yg-lock.deterministic.json   (gitignored) → deterministic-aspect verdicts
//
// This helper reads those COMMITTED ARTIFACTS directly with `fs` and merges them
// into the same unified `{ version, verdicts, nodes }` view the CLI keeps in
// memory. It deliberately imports NOTHING from `../../src/**` — the e2e suites
// exercise only the public CLI surface (the spawned binary) plus the on-disk
// files it produces, so they never couple to the CLI's internal modules.
//
// It is a plain reader, NOT a re-implementation of verification: it parses the
// JSON the CLI already wrote and unions the two verdict maps. An absent file is
// valid cold-start state and contributes nothing (the deterministic file is
// absent on a fresh clone until `yg check --approve --only-deterministic` writes
// it). A malformed file is surfaced as a JSON parse error — these tests only read
// locks the binary itself produced, so a parse failure is a genuine test fault,
// not a recoverable state the helper needs to model (the binary's own
// fail-closed `lock-invalid` behaviour is asserted via spawned `yg check`
// output, never through this helper).
// =============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Committed: LLM verdicts (the bulk of the committed lock). */
export const LOCK_NONDET_FILE_NAME = 'yg-lock.nondeterministic.json';
/** Committed: the per-node `nodes` section (source fingerprint + log baseline). */
export const LOCK_LOGS_FILE_NAME = 'yg-lock.logs.json';
/** Gitignored: deterministic-aspect verdicts (a free, local cache). */
export const LOCK_DET_FILE_NAME = '.yg-lock.deterministic.json';

/** Absolute path to the committed LLM-verdict file, given a project's `.yggdrasil` dir. */
export function nondetLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_NONDET_FILE_NAME);
}
/** Absolute path to the committed log/closure-state file, given a project's `.yggdrasil` dir. */
export function logsLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_LOGS_FILE_NAME);
}
/** Absolute path to the gitignored deterministic-verdict file, given a project's `.yggdrasil` dir. */
export function detLockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_DET_FILE_NAME);
}

/** A single verdict entry as serialized in the lock. */
export interface VerdictEntry {
  verdict: 'approved' | 'refused';
  hash: string;
  reason?: string;
  touched?: Array<[string, string]>;
}

/** Per-node facts recorded in the logs file. */
export interface LockNodeEntry {
  source?: string;
  log?: { last_entry_datetime: string; prefix_hash: string };
}

/** The unified lock view: a merge of the three on-disk triad files. */
export interface LockFile {
  version: number;
  verdicts: Record<string, Record<string, VerdictEntry>>;
  nodes: Record<string, LockNodeEntry>;
}

/** Shape of a single on-disk triad file (each carries all three sections). */
interface RawLockFile {
  version: number;
  verdicts?: Record<string, Record<string, VerdictEntry>>;
  nodes?: Record<string, LockNodeEntry>;
}

/** Parse one triad file; an absent file is valid cold-start state → null. */
function readOne(filePath: string): RawLockFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as RawLockFile;
}

/**
 * Read the unified lock by merging the three on-disk triad files in a project's
 * `.yggdrasil` directory.
 *
 * - `verdicts` = union of the nondeterministic (committed) and deterministic
 *   (gitignored) verdict maps. The two namespaces are disjoint by aspect kind,
 *   so the union is a plain merge.
 * - `nodes` = the `nodes` section of the committed logs file.
 * - An absent file contributes nothing (cold start).
 *
 * @param yggRoot absolute path to a project's `.yggdrasil` directory.
 */
export function readLock(yggRoot: string): LockFile {
  const nondet = readOne(nondetLockPath(yggRoot));
  const logs = readOne(logsLockPath(yggRoot));
  const det = readOne(detLockPath(yggRoot));

  const version = nondet?.version ?? logs?.version ?? det?.version ?? 1;

  return {
    version,
    verdicts: { ...(nondet?.verdicts ?? {}), ...(det?.verdicts ?? {}) },
    nodes: logs?.nodes ?? {},
  };
}
