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
    expect(result).toEqual({ version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} });
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
    };

    // Expected canonical form:
    // - outer keys: "Zeta-rule" (Z=0x5A) before "alpha-rule" (a=0x61)
    // - inner unit keys within Zeta-rule: "node:A-unit" (A=0x41) before "node:b-unit" (b=0x62)
    // - entry fields sorted by code-point: "hash" (h=0x68) < "reason" (r=0x72) < "verdict" (v=0x76)
    // - each verdict entry on ONE line
    // - nodes entry on ONE line
    const expected =
      '{\n' +
      '  "version": 1,\n' +
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

  it('readLock throws LockInvalidError on unknown version (2)', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-lock-bad-version');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    const badLock = { version: 2, verdicts: {}, nodes: {} };
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
});
