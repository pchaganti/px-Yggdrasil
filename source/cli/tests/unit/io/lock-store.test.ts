import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

import type { LockFile } from '../../../src/model/lock.js';
import { LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import {
  readLock,
  writeLock,
  serializeLock,
  LockInvalidError,
} from '../../../src/io/lock-store.js';

afterEach(async () => {
  // Clean up all tmp-lock-* directories created by these tests
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(FIXTURES_DIR).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-lock-'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('lock-store', () => {
  it('readLock returns empty lock when file absent', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-absent');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const result = readLock(tmpDir);
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, relation_verdicts: {} });
  });

  it('writeLock + readLock roundtrip preserves entries and nodes', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-roundtrip');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': { verdict: 'approved', hash: 'abc123' },
          'node:billing/notify': {
            verdict: 'refused',
            hash: 'def456',
            reason: 'missing log',
            touched: [['read:src/shared/codes.ts', 'sha-xyz']],
          },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fingerprint-abc',
          log: { last_entry_datetime: '2026-06-12T10:00:00.000Z', prefix_hash: 'loghash' },
        },
      },
      relation_verdicts: {},
    };
    await writeLock(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  it('serializeLock emits code-point-sorted keys, one entry per line, trailing newline', () => {
    // 'Z' (0x5A) must sort BEFORE 'a' (0x61) in code-point order
    // 'Zeta-rule' < 'alpha-rule' in code-point order
    // unit keys: 'node:A-unit' < 'node:b-unit' in code-point order (A=0x41 < b=0x62)
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'alpha-rule': {
          'node:b-unit': { verdict: 'approved', hash: 'hash-alpha-b' },
        },
        'Zeta-rule': {
          'node:A-unit': { verdict: 'refused', hash: 'hash-zeta-A', reason: 'violation text' },
          'node:b-unit': { verdict: 'approved', hash: 'hash-zeta-b' },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fp-billing',
        },
      },
      relation_verdicts: {
        'node:z-unit': { verdict: 'approved', fingerprint: 'fp-z' },
        'node:a-unit': { verdict: 'refused', fingerprint: 'fp-a', reason: 'undeclared dep' },
      },
    };

    // Expected canonical form:
    // - outer keys: "Zeta-rule" (Z=0x5A) before "alpha-rule" (a=0x61)
    // - inner unit keys within Zeta-rule: "node:A-unit" (A=0x41) before "node:b-unit" (b=0x62)
    // - entry fields sorted by code-point: "hash" (h=0x68) < "reason" (r=0x72) < "verdict" (v=0x76)
    // - each verdict entry on ONE line
    // - nodes entry on ONE line
    // - relation_verdicts: unit keys code-point sorted ("node:a-unit" < "node:z-unit");
    //   entry fields sorted ("fingerprint" < "reason" < "verdict"); absent reason omitted
    const expected =
      '{\n' +
      '  "version": 2,\n' +
      '  "verdicts": {\n' +
      '    "Zeta-rule": {\n' +
      '      "node:A-unit": {"hash":"hash-zeta-A","reason":"violation text","verdict":"refused"},\n' +
      '      "node:b-unit": {"hash":"hash-zeta-b","verdict":"approved"}\n' +
      '    },\n' +
      '    "alpha-rule": {\n' +
      '      "node:b-unit": {"hash":"hash-alpha-b","verdict":"approved"}\n' +
      '    }\n' +
      '  },\n' +
      '  "nodes": {\n' +
      '    "billing/cancel": {"source":"fp-billing"}\n' +
      '  },\n' +
      '  "relation_verdicts": {\n' +
      '    "node:a-unit": {"fingerprint":"fp-a","reason":"undeclared dep","verdict":"refused"},\n' +
      '    "node:z-unit": {"fingerprint":"fp-z","verdict":"approved"}\n' +
      '  }\n' +
      '}\n';

    const result = serializeLock(lock);
    expect(result).toBe(expected);
  });

  it('readLock throws LockInvalidError on unparseable JSON', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-bad-json');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-lock.json'), 'not valid json { {', 'utf-8');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError on an unsupported future version (3)', async () => {
    // Version 1 and 2 are accepted (1 is migrated); a higher version was written by
    // a newer CLI and must fail closed rather than be misinterpreted.
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-bad-version');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const badLock = { version: 3, verdicts: {}, nodes: {}, relation_verdicts: {} };
    await writeFile(path.join(tmpDir, 'yg-lock.json'), JSON.stringify(badLock), 'utf-8');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('LockInvalidError for content containing "<<<<<<<" names git conflict markers and its next: includes the take-a-side procedure (git checkout --ours|--theirs -- .yggdrasil/yg-lock.json, then yg check --approve)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-conflict');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const conflictContent =
      '<<<<<<< HEAD\n{"version":1,"verdicts":{},"nodes":{}}\n=======\n{"version":1,"verdicts":{},"nodes":{}}\n>>>>>>> branch\n';
    await writeFile(path.join(tmpDir, 'yg-lock.json'), conflictContent, 'utf-8');
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { what, next } = err.messageData;
    // Must mention git conflict markers
    expect(what.toLowerCase()).toMatch(/conflict/);
    // next must include the take-a-side git commands
    expect(next).toMatch(/git checkout --ours/);
    expect(next).toMatch(/git checkout --theirs/);
    expect(next).toMatch(/\.yggdrasil\/yg-lock\.json/);
    expect(next).toMatch(/yg check --approve/);
  });

  it('LockInvalidError next: names both recoveries (restore from git / delete the file and re-fill via yg check --approve) and states the full re-verification cost', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-both-recoveries');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-lock.json'), '{ invalid json }', 'utf-8');
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { next } = err.messageData;
    // Must name: restore from git
    expect(next).toMatch(/git/);
    // Must name: delete + re-fill via yg check --approve
    expect(next).toMatch(/yg check --approve/);
    // Must state re-verification cost
    expect(next).toMatch(/re.verif/i);
  });

  it('readLock does NOT throw when a reason string contains "<<<<<<< HEAD" inside JSON', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-reason-lt7');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': {
            verdict: 'refused',
            hash: 'abc123',
            reason: 'reviewer quoted: <<<<<<< HEAD in source',
          },
        },
      },
      nodes: {},
      relation_verdicts: {},
    };
    // Write via writeLock — serializer must escape the angle brackets inside the JSON string.
    await writeLock(tmpDir, lock);
    // readLock must NOT throw — the line-anchored regex must not match inside JSON string content.
    const result = readLock(tmpDir);
    expect(result.verdicts['my-aspect']['node:billing/cancel'].reason).toBe(
      'reviewer quoted: <<<<<<< HEAD in source',
    );
  });

  it('serializer escaping: roundtrip a reason with quotes, newline, and backslash keeps each entry on a single line and returns the exact original string', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-escape');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const tricky = 'has "quotes"\nand newline\t\\backslash';
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': {
            verdict: 'refused',
            hash: 'abc123',
            reason: tricky,
          },
        },
      },
      nodes: {},
      relation_verdicts: {},
    };
    await writeLock(tmpDir, lock);
    // (i) Each verdict entry must appear on a single line (no raw newline inside the entry line).
    const serialized = serializeLock(lock);
    // Find the line containing the entry for 'node:billing/cancel'
    const entryLines = serialized
      .split('\n')
      .filter((l) => l.includes('"node:billing/cancel"'));
    expect(entryLines).toHaveLength(1);
    // (ii) readLock roundtrip returns the exact original string.
    const result = readLock(tmpDir);
    expect(result.verdicts['my-aspect']['node:billing/cancel'].reason).toBe(tricky);
  });

  it('unknown-field drop: extra properties on VerdictEntry are not serialized and roundtrip yields only known fields', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-extra-field');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const entryWithExtra = {
      verdict: 'approved' as const,
      hash: 'abc123',
      __extraField: 'should-be-dropped',
    } as unknown as import('../../../src/model/lock.js').VerdictEntry;
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': entryWithExtra,
        },
      },
      nodes: {},
      relation_verdicts: {},
    };
    const serialized = serializeLock(lock);
    // The extra field must not appear in the serialized output.
    expect(serialized).not.toContain('__extraField');
    expect(serialized).not.toContain('should-be-dropped');
    // Roundtrip via write+read yields only the known fields.
    await writeLock(tmpDir, lock);
    const result = readLock(tmpDir);
    const entry = result.verdicts['my-aspect']['node:billing/cancel'];
    expect(entry).toEqual({ verdict: 'approved', hash: 'abc123' });
    expect(Object.keys(entry)).not.toContain('__extraField');
  });

  it('writeLock writes atomically (temp + rename via the existing atomic write helper)', async () => {
    // We verify atomicity by confirming no .tmp file is left behind after write,
    // and that the lock can be read back correctly.
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-atomic');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {},
      nodes: {},
      relation_verdicts: {},
    };
    await writeLock(tmpDir, lock);
    // Verify no .tmp file left (atomic write cleans up)
    const tmpFilePath = path.join(tmpDir, 'yg-lock.json.tmp');
    let tmpExists = false;
    try {
      await stat(tmpFilePath);
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
    // Verify the lock was written and can be read back
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  // ── Shape validation — the lock must FAIL CLOSED on a malformed structure. ──
  // Before the fix, readLock coerced a wrong-shaped `verdicts`/`nodes` to `{}` and
  // returned the entries otherwise as-is. Each of the cases below would therefore
  // have passed THROUGH the pre-fix readLock (fail open):
  //   - `verdicts: []` / `nodes: []` → coerced to `{}` → "no verdicts" / "no node
  //     baseline" with no lock-invalid signal (everything silently unverified, the
  //     log-integrity baseline silently absent);
  //   - a verdict entry missing `hash`, with a non-string `verdict`, or a node entry
  //     with a malformed `log` → returned verbatim, then crashing a downstream consumer
  //     (fill.ts setEntry, verifyLock, log-integrity) with an UNCLASSIFIED error rather
  //     than the fail-closed lock-invalid.
  // The fix routes every one of these to LockInvalidError (fail closed).

  /** Write a raw (possibly malformed) lock file and read it back. */
  async function writeRawLock(name: string, content: string): Promise<string> {
    const tmpDir = path.join(FIXTURES_DIR, name);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-lock.json'), content, 'utf-8');
    return tmpDir;
  }

  it('readLock throws LockInvalidError when verdicts is an array (fail closed, not coerced to empty)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-verdicts-array',
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: [], nodes: {} }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a verdict entry is missing hash', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-no-hash',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': { verdict: 'approved' } } },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a verdict entry has a non-string verdict', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-bad-verdict',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': { verdict: 1, hash: 'abc123' } } },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when nodes is an array (fail closed — log baseline not silently absent)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-nodes-array',
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: [] }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes entry has a malformed log', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-node-bad-log',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        // log is a string, not the {last_entry_datetime, prefix_hash} object.
        nodes: { 'billing/cancel': { source: 'fp', log: 'not-an-object' } },
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock routes a =======/>>>>>>> conflict fragment to the conflict (take-a-side) message', async () => {
    // A half-resolved merge where ONLY the lower half survived: no leading <<<<<<< marker,
    // but the ======= / >>>>>>> markers remain. Must still be detected as a conflict.
    const tmpDir = await writeRawLock(
      'tmp-lock-conflict-fragment',
      '{"version":1,"verdicts":{},"nodes":{}}\n=======\n{"version":1,"verdicts":{},"nodes":{}}\n>>>>>>> branch\n',
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    const err = thrown as InstanceType<typeof LockInvalidError>;
    const { what, next } = err.messageData;
    // Must be the conflict-specific message (take-a-side recovery), NOT a generic parse error.
    expect(what.toLowerCase()).toMatch(/conflict/);
    expect(next).toMatch(/git checkout --ours/);
    expect(next).toMatch(/git checkout --theirs/);
    expect(next).toMatch(/yg check --approve/);
  });

  it('regression: a well-formed lock (refused entry with multi-line reason + touched, node with source+log) round-trips exactly', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-wellformed-roundtrip');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {
        'my-aspect': {
          'node:billing/cancel': { verdict: 'approved', hash: 'abc123' },
          'file:src/billing/x.ts': {
            verdict: 'refused',
            hash: 'def456',
            reason: 'line one\nline two\nline three',
            touched: [
              ['read:src/shared/codes.ts', 'sha-xyz'],
              ['list:src/billing', 'sha-list'],
            ],
          },
        },
      },
      nodes: {
        'billing/cancel': {
          source: 'fingerprint-abc',
          log: { last_entry_datetime: '2026-06-12T10:00:00.000Z', prefix_hash: 'loghash' },
        },
      },
      relation_verdicts: {},
    };
    await writeLock(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result).toEqual(lock);
  });

  it('regression: an absent lock file reads back as an empty lock (NOT lock-invalid)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-absent-not-invalid');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    // No file written — absent file is legitimate cold-start state.
    expect(() => readLock(tmpDir)).not.toThrow();
    const result = readLock(tmpDir);
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, relation_verdicts: {} });
  });

  // ── Every malformed-shape rejection arm of validateLockShape (fail closed). ──
  // Each case below exercises a distinct structural-deviation branch. The previous
  // suite covered a handful (array verdicts/nodes, missing hash, non-string verdict,
  // bad log object); these complete the enumeration so every `throwMalformed` arm is
  // proven to reject (LockInvalidError) rather than silently pass.

  it('readLock rethrows a non-ENOENT filesystem error (e.g. EISDIR when the lock path is a directory)', async () => {
    // Point readLock at a directory whose "yg-lock.json" is itself a directory:
    // readFileSync then throws EISDIR (not ENOENT), which must propagate unchanged
    // (NOT be swallowed into an empty cold-start lock).
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-eisdir');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, 'yg-lock.json'), { recursive: true });
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Not the cold-start empty lock — a real fs error surfaced.
    expect((thrown as NodeJS.ErrnoException).code).toBe('EISDIR');
    // And NOT a LockInvalidError — a genuine fs failure is distinct from corruption.
    expect(thrown).not.toBeInstanceOf(LockInvalidError);
  });

  it('readLock throws LockInvalidError when the JSON is null (not an object)', async () => {
    const tmpDir = await writeRawLock('tmp-lock-null', 'null');
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when version is missing (non-numeric)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-no-version',
      JSON.stringify({ verdicts: {}, nodes: {} }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /numeric version/i,
    );
  });

  it('readLock throws LockInvalidError on an unexpected top-level key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-extra-top-key',
      JSON.stringify({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {}, extra: 1 }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected top-level key "extra"/,
    );
  });

  it('readLock throws LockInvalidError when verdicts.<aspectId> is not an object (the unit map)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-unitmap-not-object',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': 42 },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /"verdicts\.my-aspect" must be a JSON object/,
    );
  });

  it('readLock throws LockInvalidError when a verdict entry is null (not a plain object)', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-null',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: { 'my-aspect': { 'node:billing/cancel': null } },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    // describe(null) → "null": exercises the null arm of describe().
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(/null/);
  });

  it('readLock throws LockInvalidError when a verdict entry has an unexpected key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-extra-key',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': { 'node:billing/cancel': { verdict: 'approved', hash: 'h', bogus: 1 } },
        },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected key "bogus"/,
    );
  });

  it('readLock throws LockInvalidError when a verdict entry reason is a non-string', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-entry-bad-reason',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:billing/cancel': { verdict: 'approved', hash: 'h', reason: 123 },
          },
        },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when touched is present but not an array', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-touched-not-array',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            'node:billing/cancel': { verdict: 'approved', hash: 'h', touched: 'nope' },
          },
        },
        nodes: {},
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a touched element is not a [string, string] pair', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-touched-bad-pair',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {
          'my-aspect': {
            // pair has wrong arity / wrong element types
            'node:billing/cancel': { verdict: 'approved', hash: 'h', touched: [['only-one']] },
          },
        },
        nodes: {},
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /touched\[0\]" must be a \[string, string\] pair/,
    );
  });

  it('readLock throws LockInvalidError when a nodes entry is not a plain object', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-node-not-object',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': 7 },
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes entry has an unexpected key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-node-extra-key',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { source: 'fp', mystery: true } },
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /unexpected key "mystery"/,
    );
  });

  it('readLock throws LockInvalidError when a nodes entry source is a non-string', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-node-bad-source',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: { 'billing/cancel': { source: 99 } },
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes log has an unexpected key', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-log-extra-key',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: {
          'billing/cancel': {
            log: { last_entry_datetime: 'x', prefix_hash: 'y', sneaky: 1 },
          },
        },
      }),
    );
    let thrown: unknown;
    try {
      readLock(tmpDir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockInvalidError);
    expect((thrown as InstanceType<typeof LockInvalidError>).messageData.what).toMatch(
      /log" has unexpected key "sneaky"/,
    );
  });

  it('readLock throws LockInvalidError when a nodes log.last_entry_datetime is a non-string', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-log-bad-datetime',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: {
          'billing/cancel': { log: { last_entry_datetime: 5, prefix_hash: 'y' } },
        },
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('readLock throws LockInvalidError when a nodes log.prefix_hash is a non-string', async () => {
    const tmpDir = await writeRawLock(
      'tmp-lock-log-bad-prefix',
      JSON.stringify({
        version: LOCK_FORMAT_VERSION,
        verdicts: {},
        nodes: {
          'billing/cancel': { log: { last_entry_datetime: 'x', prefix_hash: 9 } },
        },
      }),
    );
    expect(() => readLock(tmpDir)).toThrow(LockInvalidError);
  });

  it('serializeNodeEntry renders an empty node entry (no source, no log) as {}', async () => {
    // A node entry that has neither source nor log must serialize to "{}" (the
    // sortedKeys.length === 0 branch of serializeNodeEntry) and round-trip cleanly.
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-empty-node');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const lock: LockFile = {
      version: LOCK_FORMAT_VERSION,
      verdicts: {},
      nodes: { 'billing/cancel': {} },
      relation_verdicts: {},
    };
    const serialized = serializeLock(lock);
    expect(serialized).toContain('"billing/cancel": {}');
    await writeLock(tmpDir, lock);
    const result = readLock(tmpDir);
    expect(result.nodes['billing/cancel']).toEqual({});
  });
});
