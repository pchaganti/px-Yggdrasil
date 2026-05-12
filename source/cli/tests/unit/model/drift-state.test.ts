import { describe, it, expect } from 'vitest';
import type { DriftNodeState } from '../../../src/model/drift.js';

describe('DriftNodeState', () => {
  it('accepts optional log field with last_entry_datetime and prefix_hash', () => {
    const state: DriftNodeState = {
      hash: 'abc',
      files: { 'src/foo.ts': 'h1' },
      log: {
        last_entry_datetime: '2026-05-11T14:23:00.123Z',
        prefix_hash: 'sha256hex',
      },
    };
    expect(state.log?.last_entry_datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(state.log?.prefix_hash).toBe('sha256hex');
  });

  it('accepts state without log field (backwards compatible)', () => {
    const state: DriftNodeState = {
      hash: 'abc',
      files: {},
    };
    expect(state.log).toBeUndefined();
  });
});
