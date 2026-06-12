import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IssueMessage } from '../model/validation.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { LockFile, VerdictEntry, LockNodeEntry } from '../model/lock.js';
import { LOCK_FORMAT_VERSION, LOCK_FILE_NAME } from '../model/lock.js';
import { atomicWriteFile } from '../io/atomic-write.js';

/**
 * The lock file is unparseable, structurally invalid, or has an unrecognized
 * version. Fail closed — the runtime never returns a partial lock.
 *
 * Covers:
 * - Unparseable JSON
 * - git conflict markers (<<<<<<<)
 * - Unknown version number
 * - Structurally garbled content (missing version, wrong shape)
 */
export class LockInvalidError extends Error {
  readonly code = 'lock-invalid';
  readonly messageData: IssueMessage;

  constructor(messageData: IssueMessage) {
    super(buildIssueMessage(messageData));
    this.name = 'LockInvalidError';
    this.messageData = messageData;
  }
}

/** Absolute path to the lock file given the .yggdrasil root directory. */
export function lockPath(yggRoot: string): string {
  return path.join(yggRoot, LOCK_FILE_NAME);
}

/**
 * Read the lock file synchronously.
 *
 * - Absent file → empty lock (all expected pairs unverified — cold start).
 * - Garbled / invalid version → LockInvalidError (fail closed).
 *
 * Never returns a partial lock from a garbled file.
 */
export function readLock(yggRoot: string): LockFile {
  const filePath = lockPath(yggRoot);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absent file is valid cold-start state — return empty lock.
      return { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    }
    throw err;
  }

  // Detect git conflict markers before attempting JSON parse.
  if (raw.includes('<<<<<<<')) {
    throw new LockInvalidError({
      what: `${LOCK_FILE_NAME} contains git conflict markers — the file was not resolved after a merge`,
      why: 'a conflict-markered lock file cannot be parsed; allowing partial content would let stale or wrong verdicts pass as valid, silently breaking enforcement',
      next:
        'resolve the conflict by taking one side wholesale:\n' +
        '  git checkout --ours -- .yggdrasil/yg-lock.json\n' +
        '  OR\n' +
        '  git checkout --theirs -- .yggdrasil/yg-lock.json\n' +
        'Then run `yg check --approve` to re-verify all pairs whose verdicts may have changed.\n' +
        'Hand-stitching entries line-by-line is forbidden — structural damage makes the whole file lock-invalid.\n' +
        'Note: re-running `yg check --approve` will re-verify all unverified pairs (full re-verification cost).',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LockInvalidError({
      what: `${LOCK_FILE_NAME} contains unparseable JSON`,
      why: 'a garbled lock file cannot be read; allowing partial content would silently skip enforcement on unreadable entries',
      next:
        'restore the file from git (`git checkout HEAD -- .yggdrasil/yg-lock.json`), OR\n' +
        'delete the file and re-fill via `yg check --approve` — this will re-verify all pairs (full re-verification cost).',
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockInvalidError({
      what: `${LOCK_FILE_NAME} does not contain a JSON object`,
      why: 'the lock file must be a JSON object with a numeric version field; a non-object cannot be validated',
      next:
        'restore the file from git (`git checkout HEAD -- .yggdrasil/yg-lock.json`), OR\n' +
        'delete the file and re-fill via `yg check --approve` — this will re-verify all pairs (full re-verification cost).',
    });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new LockInvalidError({
      what: `${LOCK_FILE_NAME} is missing a numeric version field`,
      why: 'the lock file format requires a numeric version field to validate compatibility; without it the file cannot be trusted',
      next:
        'restore the file from git (`git checkout HEAD -- .yggdrasil/yg-lock.json`), OR\n' +
        'delete the file and re-fill via `yg check --approve` — this will re-verify all pairs (full re-verification cost).',
    });
  }

  if (obj.version !== LOCK_FORMAT_VERSION) {
    throw new LockInvalidError({
      what: `${LOCK_FILE_NAME} has unsupported version ${obj.version} (this CLI reads version ${LOCK_FORMAT_VERSION})`,
      why: 'an unrecognized lock version means the file was written by a different or newer CLI; parsing it would risk silently misinterpreting its structure',
      next:
        'restore the file from git (`git checkout HEAD -- .yggdrasil/yg-lock.json`), OR\n' +
        'delete the file and re-fill via `yg check --approve` — this will re-verify all pairs (full re-verification cost).',
    });
  }

  // Return the parsed lock, trusting the stored structure.
  // Runtime validation of inner fields is deferred to consumers.
  return {
    version: LOCK_FORMAT_VERSION,
    verdicts: (typeof obj.verdicts === 'object' && obj.verdicts !== null && !Array.isArray(obj.verdicts)
      ? obj.verdicts
      : {}) as Record<string, Record<string, VerdictEntry>>,
    nodes: (typeof obj.nodes === 'object' && obj.nodes !== null && !Array.isArray(obj.nodes)
      ? obj.nodes
      : {}) as Record<string, LockNodeEntry>,
  };
}

/**
 * Canonical serialization of a lock file.
 *
 * Rules (spec §3):
 * - Keys sorted by code-point order (plain Array.prototype.sort(), never localeCompare) at every level.
 * - 2-space indent for the outer structure (version, verdicts, nodes sections).
 * - Each VerdictEntry and each LockNodeEntry rendered on a SINGLE line (compact JSON for leaf values).
 * - Trailing newline.
 *
 * This is a custom serializer — bare JSON.stringify with indent=2 puts entry fields on
 * separate lines, which is not acceptable.
 */
export function serializeLock(lock: LockFile): string {
  const lines: string[] = ['{'];

  lines.push(`  "version": ${lock.version},`);
  lines.push('  "verdicts": {');

  const aspectIds = Object.keys(lock.verdicts).sort();
  for (let ai = 0; ai < aspectIds.length; ai++) {
    const aspectId = aspectIds[ai];
    const unitMap = lock.verdicts[aspectId];
    lines.push(`    ${JSON.stringify(aspectId)}: {`);

    const unitKeys = Object.keys(unitMap).sort();
    for (let ui = 0; ui < unitKeys.length; ui++) {
      const unitKey = unitKeys[ui];
      const entry = unitMap[unitKey];
      const isLast = ui === unitKeys.length - 1;
      const comma = isLast ? '' : ',';
      lines.push(`      ${JSON.stringify(unitKey)}: ${serializeEntry(entry)}${comma}`);
    }

    const isLastAspect = ai === aspectIds.length - 1;
    lines.push(`    }${isLastAspect ? '' : ','}`);
  }

  lines.push('  },');
  lines.push('  "nodes": {');

  const nodePaths = Object.keys(lock.nodes).sort();
  for (let ni = 0; ni < nodePaths.length; ni++) {
    const nodePath = nodePaths[ni];
    const nodeEntry = lock.nodes[nodePath];
    const isLast = ni === nodePaths.length - 1;
    const comma = isLast ? '' : ',';
    lines.push(`    ${JSON.stringify(nodePath)}: ${serializeNodeEntry(nodeEntry)}${comma}`);
  }

  lines.push('  }');
  lines.push('}');
  lines.push(''); // trailing newline (join adds \n between, so this creates the trailing \n)

  return lines.join('\n');
}

/**
 * Serialize a VerdictEntry on a single line.
 * Fields are code-point sorted; optional fields omitted when absent.
 */
function serializeEntry(entry: VerdictEntry): string {
  // Collect all fields, sort keys code-point, render compactly.
  const obj: Record<string, unknown> = {};
  // Always-present fields first
  obj.verdict = entry.verdict;
  obj.hash = entry.hash;
  if (entry.reason !== undefined) obj.reason = entry.reason;
  if (entry.touched !== undefined) obj.touched = entry.touched;

  // Sort keys by code-point
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Serialize a LockNodeEntry on a single line.
 * Fields are code-point sorted; optional fields omitted when absent.
 */
function serializeNodeEntry(entry: LockNodeEntry): string {
  const obj: Record<string, unknown> = {};
  if (entry.source !== undefined) obj.source = entry.source;
  if (entry.log !== undefined) obj.log = entry.log;

  const sortedKeys = Object.keys(obj).sort();
  if (sortedKeys.length === 0) return '{}';
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Serialize the lock file to canonical form and write atomically.
 *
 * Uses the existing atomic-write helper (temp + rename) so a crash or signal
 * during the write never leaves a partial lock file.
 */
export async function writeLock(yggRoot: string, lock: LockFile): Promise<void> {
  const filePath = lockPath(yggRoot);
  const content = serializeLock(lock);
  await atomicWriteFile(filePath, content);
}
