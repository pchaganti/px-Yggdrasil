import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearDraftAspectsFromDriftState } from '../../../src/io/drift-state-store.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

describe('clearDraftAspectsFromDriftState — deterministic read-set preservation', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(tmpdir(), 'yg-clear-draft-'));
    mkdirSync(path.join(yggRoot, '.drift-state'), { recursive: true });
  });
  afterEach(() => rmSync(yggRoot, { recursive: true, force: true }));

  it('preserves identity.aspects[id].checkTouched when clearing a draft aspect verdict', async () => {
    const stateFile = path.join(yggRoot, '.drift-state', 'A.json');
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'x',
      files: {},
      identity: {
        ownSubset: 'o',
        ports: {},
        aspects: { s1: { meta: 'm', checkTouched: { 'src/a.ts': 'hh' } } },
      },
      aspectVerdicts: { s1: { verdict: 'approved' } },
    }, null, 2));
    await clearDraftAspectsFromDriftState(yggRoot, 'A', new Set(['s1']));
    const updated = JSON.parse(readFileSync(stateFile, 'utf8'));
    // Verdict evicted (retains empty map), but the read-set is preserved.
    expect(updated.aspectVerdicts).toEqual({});
    expect(updated.identity.aspects.s1.checkTouched['src/a.ts']).toBe('hh');
  });
});
