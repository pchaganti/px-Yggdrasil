import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readLegacyLock, writeLock } from '../io/lock-store.js';
import {
  LOCK_FILE_NAME,
  LOCK_NONDET_FILE_NAME,
  LOCK_LOGS_FILE_NAME,
  LOCK_DET_FILE_NAME,
} from '../model/lock.js';
import { toPosixPath } from '../utils/posix.js';

type StepResult = { actions: string[]; warnings: string[] };

/**
 * 5.1.0 lock split: the single `yg-lock.json` becomes a triad —
 *   - `yg-lock.nondeterministic.json` (committed) — LLM verdicts
 *   - `yg-lock.logs.json`             (committed) — the `nodes` section
 *   - `.yg-lock.deterministic.json`   (gitignored) — deterministic verdicts
 *
 * Verdicts are relocated VERBATIM (content-addressed; partition does not alter hashes), so
 * the upgrade costs zero re-verification — a naive rename would drop the committed LLM
 * verdicts and force a full re-approve.
 *
 * Idempotent: a no-op once the legacy file is gone (already split, or a fresh init).
 *
 * The deterministic-aspect set is derived by scanning `aspects/<id>/check.mjs` presence
 * (NOT by the lock's `touched` field — a companion-backed LLM entry also carries `touched`).
 * The graph is NOT loaded here: during `yg init --upgrade` the on-disk config version still
 * predates 5.1.0, so the graph loader's version gate would reject it.
 */
export async function splitLock(yggRoot: string): Promise<StepResult> {
  const legacy = readLegacyLock(yggRoot);
  if (legacy === null) return { actions: [], warnings: [] };

  const deterministicAspectIds = scanDeterministicAspectIds(yggRoot);

  // Partition + write the triad from the unified legacy lock.
  await writeLock(yggRoot, legacy, { scope: 'all', deterministicAspectIds });

  // Remove the legacy single file.
  await rm(path.join(yggRoot, LOCK_FILE_NAME), { force: true });

  const actions = [
    `split ${LOCK_FILE_NAME} into ${LOCK_NONDET_FILE_NAME} + ${LOCK_LOGS_FILE_NAME} (committed) ` +
      `and ${LOCK_DET_FILE_NAME} (gitignored); verdicts preserved (no re-verification)`,
  ];
  const gitignoreAction = await ensureDetGitignored(yggRoot);
  if (gitignoreAction) actions.push(gitignoreAction);

  return { actions, warnings: [] };
}

/**
 * Set of deterministic aspect ids: an aspect ships `check.mjs`. The aspect id is the POSIX
 * relative path of its directory under `aspects/` (the loader's convention), which matches
 * the verdict keys in the lock.
 */
function scanDeterministicAspectIds(yggRoot: string): Set<string> {
  const aspectsRoot = path.join(yggRoot, 'aspects');
  const ids = new Set<string>();
  if (!existsSync(aspectsRoot)) return ids;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'check.mjs') {
        ids.add(toPosixPath(path.relative(aspectsRoot, dir)));
      }
    }
  };
  walk(aspectsRoot);
  return ids;
}

/** Append the gitignored deterministic lock to `.yggdrasil/.gitignore` if not already ignored. */
async function ensureDetGitignored(yggRoot: string): Promise<string | null> {
  const giPath = path.join(yggRoot, '.gitignore');
  let content = '';
  try {
    content = await readFile(giPath, 'utf-8');
  } catch {
    // Absent → will be created with the entry.
  }
  if (content.split('\n').some((line) => line.trim() === LOCK_DET_FILE_NAME)) return null;

  const needsNewline = content.length > 0 && !content.endsWith('\n');
  await writeFile(giPath, `${content}${needsNewline ? '\n' : ''}${LOCK_DET_FILE_NAME}\n`, 'utf-8');
  return `added ${LOCK_DET_FILE_NAME} to .yggdrasil/.gitignore`;
}
