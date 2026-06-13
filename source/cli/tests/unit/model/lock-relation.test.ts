import { describe, it, expect } from 'vitest';
import { LOCK_FORMAT_VERSION, nodeUnit, type LockFile, type RelationVerdict } from '../../../src/model/lock.js';

describe('lock model — relation_verdicts', () => {
  it('LOCK_FORMAT_VERSION is 2', () => {
    expect(LOCK_FORMAT_VERSION).toBe(2);
  });
  it('LockFile carries a relation_verdicts map keyed by node unit', () => {
    const v: RelationVerdict = { verdict: 'refused', fingerprint: 'abc', reason: 'x imports y' };
    const lock: LockFile = { version: 2, verdicts: {}, nodes: {}, relation_verdicts: { [nodeUnit('a/b')]: v } };
    expect(lock.relation_verdicts[nodeUnit('a/b')].verdict).toBe('refused');
  });
});
