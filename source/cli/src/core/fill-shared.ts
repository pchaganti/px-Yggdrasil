/**
 * source/cli/src/core/fill-shared.ts — small shared types and utilities for the
 * fill stage (spec §7). These are the leaf primitives the per-kind fillers
 * (deterministic, LLM), the worker pool, and the orchestrator all build on; they
 * live here so the cohesive fill modules share them without a circular import.
 */

import type { VerdictEntry } from '../model/lock.js';
import type { IssueMessage } from '../model/validation.js';
import { debugWrite } from '../utils/debug-log.js';

/** Outcome of filling one deterministic pair. A real verdict carries an entry to
 *  write; a runtime-error is an infra disposition (no write — spec §3.2). */
export type DetFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry }
  | { kind: 'runtime-error' };

/** Outcome of filling one LLM pair. A real verdict carries an entry to write; an
 *  infra disposition (reference unreadable, provider error/unparseable) carries a
 *  reason and writes NOTHING (spec §3.2). `callsMade` is consensus-inclusive.
 *  The infra disposition also carries structured `messageData` ({ what, why, next })
 *  so the failure is self-describing at the point it is produced — the bare `why`
 *  stays for callers that fold it into their own surrounding message. */
export type LlmFillOutcome =
  | { kind: 'verdict'; entry: VerdictEntry; callsMade: number }
  | { kind: 'infra'; why: string; messageData?: IssueMessage; callsMade: number };

/**
 * Read a file's raw bytes, returning an empty Buffer when the file is missing or
 * unreadable. Used by both the deterministic and LLM fillers to hash subject
 * files from current disk — a deleted subject hashes to the empty-buffer hash,
 * which mirrors the verifier's re-read and keeps producer/verifier in sync.
 */
export async function readBytesOrEmpty(absPath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(absPath);
  } catch (e) {
    debugWrite(`[fill] readBytesOrEmpty failed for ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return Buffer.alloc(0);
  }
}
