import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IssueMessage } from '../model/validation.js';
import type { LockFile, VerdictEntry, LockNodeEntry } from '../model/lock.js';
import { LOCK_FORMAT_VERSION, LOCK_FILE_NAME } from '../model/lock.js';
import { atomicWriteFile } from '../io/atomic-write.js';

/**
 * The lock file is unparseable, structurally invalid, or has an unrecognized
 * version. Fail closed — the runtime never returns a partial lock.
 *
 * Covers:
 * - Unparseable JSON
 * - git conflict markers (any of <<<<<<<, =======, >>>>>>>, line-leading)
 * - Unknown version number
 * - Structurally garbled content (missing version, wrong shape, unknown keys)
 */
export class LockInvalidError extends Error {
  readonly code = 'lock-invalid';
  readonly messageData: IssueMessage;

  constructor(messageData: IssueMessage) {
    super(messageData.what);
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
  // Line-anchored regex: real git conflict markers START a line. We match ANY of the three
  // marker families (<<<<<<<, =======, >>>>>>>) so a half-resolved file where only the
  // =======/>>>>>>> side survived is still routed to the conflict-specific recovery (taking a
  // side) rather than falling through to a worse generic parse error. The trailing space is NOT
  // required (a marker without a label, e.g. a bare `=======`, is still a conflict marker).
  // A bare substring check would falsely trigger on a verdict reason that quotes diff/conflict
  // text mid-line — the `^…$`/`m` anchoring keeps the marker line-leading so an embedded run of
  // 7 angle brackets inside a `reason` string cannot false-positive.
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(raw)) {
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

  // Validate the SHAPE of the parsed lock. The lock is the only persisted verification state;
  // a malformed shape must fail CLOSED (LockInvalidError), never silently coerce to empty. The
  // previous behavior — coercing a wrong-shaped `verdicts`/`nodes` to `{}` — was fail-OPEN: a
  // hand-corrupted `"verdicts": []` became "no verdicts" (everything unverified, but with no
  // lock-invalid signal) and a `"nodes": []` made the log-integrity baseline silently absent.
  // Strict-by-design: the format is fully enumerated and version-gated (an unknown `version`
  // already fails closed above; version bumps — not extra keys — are the extensibility
  // mechanism), the canonical serializer only ever emits the known keys, and no consumer reads
  // any unknown key. So unknown keys at any level are treated as corruption and rejected.
  validateLockShape(obj);

  // Shape is valid — the parsed object is structurally a LockFile. The cast is sound because
  // validateLockShape threw on anything that is not.
  return {
    version: LOCK_FORMAT_VERSION,
    verdicts: obj.verdicts as Record<string, Record<string, VerdictEntry>>,
    nodes: obj.nodes as Record<string, LockNodeEntry>,
  };
}

/** True for a non-null, non-array object — the "plain object" shape every lock map/entry must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Raise the canonical fail-closed corruption error with the restore-or-refill recovery. */
function throwMalformed(detail: string): never {
  throw new LockInvalidError({
    what: `${LOCK_FILE_NAME} is structurally malformed — ${detail}`,
    why: 'the lock is the only persisted verification state; a malformed lock cannot be trusted, and silently treating it as empty would let unverified code pass as verified (fail open)',
    next:
      'restore the file from git (`git checkout HEAD -- .yggdrasil/yg-lock.json`), OR\n' +
      'delete the file and re-fill via `yg check --approve` — this will re-verify all pairs (full re-verification cost).',
  });
}

/**
 * Validate the SHAPE of a parsed lock object (version already checked by the caller).
 *
 * Throws LockInvalidError on any structural deviation. Strict-by-design: only the known keys are
 * accepted at every level; unknown keys are rejected (the format is version-gated, so unknown
 * keys mean corruption, not forward-compatible extension).
 *
 * Accepted shape:
 * - top level: exactly { version, verdicts, nodes } (version validated by caller).
 * - verdicts: plain object; every value is a plain object (aspectId → unitKey → entry); every
 *   entry is a plain object with string `verdict` ∈ {approved, refused} and string `hash`;
 *   optional string `reason`; optional `touched` = array of [string, string] pairs.
 * - nodes: plain object; every value is a plain object with optional string `source` and optional
 *   `log` = plain object { last_entry_datetime: string, prefix_hash: string }.
 */
function validateLockShape(obj: Record<string, unknown>): void {
  // Top-level keys: only version / verdicts / nodes are allowed.
  const TOP_KEYS = new Set(['version', 'verdicts', 'nodes']);
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.has(key)) throwMalformed(`unexpected top-level key "${key}" (allowed: version, verdicts, nodes)`);
  }

  // verdicts must be a plain object of aspectId → (unitKey → entry).
  if (!isPlainObject(obj.verdicts)) {
    throwMalformed('"verdicts" must be a JSON object (found ' + describe(obj.verdicts) + ')');
  }
  for (const aspectId of Object.keys(obj.verdicts)) {
    const unitMap = obj.verdicts[aspectId];
    if (!isPlainObject(unitMap)) {
      throwMalformed(`"verdicts.${aspectId}" must be a JSON object (found ${describe(unitMap)})`);
    }
    for (const unitKey of Object.keys(unitMap)) {
      validateVerdictEntry(unitMap[unitKey], `verdicts.${aspectId}.${unitKey}`);
    }
  }

  // nodes must be a plain object of nodePath → node entry.
  if (!isPlainObject(obj.nodes)) {
    throwMalformed('"nodes" must be a JSON object (found ' + describe(obj.nodes) + ')');
  }
  for (const nodePath of Object.keys(obj.nodes)) {
    validateNodeEntry(obj.nodes[nodePath], `nodes.${nodePath}`);
  }
}

/** Validate a single VerdictEntry (verdict + hash required; reason + touched optional). */
function validateVerdictEntry(entry: unknown, at: string): void {
  if (!isPlainObject(entry)) throwMalformed(`"${at}" must be a JSON object (found ${describe(entry)})`);

  const ENTRY_KEYS = new Set(['verdict', 'hash', 'reason', 'touched']);
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) throwMalformed(`"${at}" has unexpected key "${key}" (allowed: verdict, hash, reason, touched)`);
  }

  if (entry.verdict !== 'approved' && entry.verdict !== 'refused') {
    throwMalformed(`"${at}.verdict" must be "approved" or "refused" (found ${describe(entry.verdict)})`);
  }
  if (typeof entry.hash !== 'string') {
    throwMalformed(`"${at}.hash" must be a string (found ${describe(entry.hash)})`);
  }
  if (entry.reason !== undefined && typeof entry.reason !== 'string') {
    throwMalformed(`"${at}.reason" must be a string when present (found ${describe(entry.reason)})`);
  }
  if (entry.touched !== undefined) {
    if (!Array.isArray(entry.touched)) {
      throwMalformed(`"${at}.touched" must be an array when present (found ${describe(entry.touched)})`);
    }
    for (let i = 0; i < entry.touched.length; i++) {
      const pair = entry.touched[i];
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== 'string' ||
        typeof pair[1] !== 'string'
      ) {
        throwMalformed(`"${at}.touched[${i}]" must be a [string, string] pair (found ${describe(pair)})`);
      }
    }
  }
}

/** Validate a single LockNodeEntry (source optional string; log optional {datetime, prefix_hash}). */
function validateNodeEntry(entry: unknown, at: string): void {
  if (!isPlainObject(entry)) throwMalformed(`"${at}" must be a JSON object (found ${describe(entry)})`);

  const NODE_KEYS = new Set(['source', 'log']);
  for (const key of Object.keys(entry)) {
    if (!NODE_KEYS.has(key)) throwMalformed(`"${at}" has unexpected key "${key}" (allowed: source, log)`);
  }

  if (entry.source !== undefined && typeof entry.source !== 'string') {
    throwMalformed(`"${at}.source" must be a string when present (found ${describe(entry.source)})`);
  }
  if (entry.log !== undefined) {
    if (!isPlainObject(entry.log)) {
      throwMalformed(`"${at}.log" must be a JSON object when present (found ${describe(entry.log)})`);
    }
    const LOG_KEYS = new Set(['last_entry_datetime', 'prefix_hash']);
    for (const key of Object.keys(entry.log)) {
      if (!LOG_KEYS.has(key)) throwMalformed(`"${at}.log" has unexpected key "${key}" (allowed: last_entry_datetime, prefix_hash)`);
    }
    if (typeof entry.log.last_entry_datetime !== 'string') {
      throwMalformed(`"${at}.log.last_entry_datetime" must be a string (found ${describe(entry.log.last_entry_datetime)})`);
    }
    if (typeof entry.log.prefix_hash !== 'string') {
      throwMalformed(`"${at}.log.prefix_hash" must be a string (found ${describe(entry.log.prefix_hash)})`);
    }
  }
}

/** Short human-readable type label for a value, used in malformed-shape messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
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
  // Pre-sorting touched (and the observation-key order) is the PRODUCER's contract — the store serializes the array as given.
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
