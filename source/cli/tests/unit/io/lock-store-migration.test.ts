import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLock, serializeLock } from '../../../src/io/lock-store.js';

function ygRoot(json: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-lockmig-'));
  writeFileSync(path.join(dir, 'yg-lock.json'), json, 'utf-8');
  return dir;
}

describe('lock-store v1→v2 migration', () => {
  it('reads a v1 lock and migrates it to v2 with empty relation_verdicts, preserving verdicts', () => {
    const dir = ygRoot(JSON.stringify({ version: 1, verdicts: { 'asp': { 'node:a': { verdict: 'approved', hash: 'h' } } }, nodes: {} }));
    try {
      const lock = readLock(dir);
      expect(lock.version).toBe(2);
      expect(lock.verdicts['asp']['node:a'].verdict).toBe('approved');
      expect(lock.relation_verdicts).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reads a v2 lock with relation_verdicts intact', () => {
    const dir = ygRoot(JSON.stringify({ version: 2, verdicts: {}, nodes: {}, relation_verdicts: { 'node:a': { verdict: 'refused', fingerprint: 'fp', reason: 'r', evidence: { sources: [], relations: '', outcomes: [], grammarVersions: [], indexIdentity: '' } } } }));
    try { expect(readLock(dir).relation_verdicts['node:a'].verdict).toBe('refused'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects an unknown top-level key (still strict)', () => {
    const dir = ygRoot(JSON.stringify({ version: 2, verdicts: {}, nodes: {}, relation_verdicts: {}, bogus: 1 }));
    try { expect(() => readLock(dir)).toThrow(/unexpected top-level key/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a malformed relation verdict entry', () => {
    const dir = ygRoot(JSON.stringify({ version: 2, verdicts: {}, nodes: {}, relation_verdicts: { 'node:a': { verdict: 'maybe', fingerprint: 'f' } } }));
    try { expect(() => readLock(dir)).toThrow(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('serializeLock round-trips relation_verdicts canonically (sorted keys, omits absent reason)', () => {
    const ev = { sources: [] as Array<[string, string]>, relations: '', outcomes: [], grammarVersions: [] as Array<[string, string]>, indexIdentity: '' };
    const out = serializeLock({ version: 2, verdicts: {}, nodes: {}, relation_verdicts: { 'node:b': { verdict: 'approved', fingerprint: 'f2', evidence: ev }, 'node:a': { verdict: 'refused', fingerprint: 'f1', reason: 'x', evidence: ev } } });
    expect(out.indexOf('"node:a"')).toBeLessThan(out.indexOf('"node:b"'));
    const parsed = JSON.parse(out);
    expect(parsed.relation_verdicts['node:a'].reason).toBe('x');
    expect(parsed.relation_verdicts['node:b'].reason).toBeUndefined();
  });
});
