import { describe, it, expect } from 'vitest';
import type { DriftNodeState } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

describe('DriftNodeState', () => {
  it('accepts a typed baseline with required fields and optional log', () => {
    const state: DriftNodeState = {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'abc',
      files: { 'src/foo.ts': 'h1' },
      identity: { ownSubset: 'o', ports: {}, aspects: {} },
      aspectVerdicts: {},
      log: {
        last_entry_datetime: '2026-05-11T14:23:00.123Z',
        prefix_hash: 'sha256hex',
      },
    };
    expect(state.log?.last_entry_datetime).toBe('2026-05-11T14:23:00.123Z');
    expect(state.log?.prefix_hash).toBe('sha256hex');
  });

  it('accepts a typed baseline without optional fields (log, mtimes)', () => {
    const state: DriftNodeState = {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'abc',
      files: {},
      identity: { ownSubset: 'o', ports: {}, aspects: {} },
      aspectVerdicts: {},
    };
    expect(state.log).toBeUndefined();
    expect(state.mtimes).toBeUndefined();
  });

  it('aspectVerdicts is required and may be empty; identity carries per-aspect slices', () => {
    const state: DriftNodeState = {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'abc',
      files: {},
      identity: {
        ownSubset: 'o',
        ports: { 'pay/svc': 'p' },
        aspects: { a: { meta: 'm', tier: 't', checkTouched: { 'src/x.ts': 'h' } } },
      },
      aspectVerdicts: { a: { verdict: 'approved' } },
    };
    expect(state.aspectVerdicts.a.verdict).toBe('approved');
    expect(state.identity.aspects.a.checkTouched).toEqual({ 'src/x.ts': 'h' });
  });
});
