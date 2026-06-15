import { describe, it, expect } from 'vitest';
import { LOCK_FORMAT_VERSION, type LockFile } from '../../../src/model/lock.js';

describe('lock model — v1, no relation cache', () => {
  it('LOCK_FORMAT_VERSION is 1 (the relation-verdict v2 bump is reverted)', () => {
    expect(LOCK_FORMAT_VERSION).toBe(1);
  });

  it('a LockFile has no relation_verdicts field', () => {
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    // @ts-expect-error relation_verdicts was removed from the LockFile type
    expect(lock.relation_verdicts).toBeUndefined();
  });
});
