import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearDraftAspectsFromDriftState } from '../../../src/io/drift-state-store.js';

describe('clearDraftAspectsFromDriftState — D8.3 structure preservation', () => {
  let yggRoot: string;
  beforeEach(() => {
    yggRoot = mkdtempSync(path.join(tmpdir(), 'yg-clear-draft-'));
    mkdirSync(path.join(yggRoot, '.drift-state'), { recursive: true });
  });
  afterEach(() => rmSync(yggRoot, { recursive: true, force: true }));

  it('preserves structureTouchedFiles entries for draft-aspect IDs', async () => {
    const stateFile = path.join(yggRoot, '.drift-state', 'A.json');
    writeFileSync(stateFile, JSON.stringify({
      hash: 'x', files: {},
      aspectVerdicts: { s1: { verdict: 'approved' } },
      structureTouchedFiles: { s1: { 'src/a.ts': 'hh' } },
    }, null, 2));
    await clearDraftAspectsFromDriftState(yggRoot, 'A', new Set(['s1']));
    const updated = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(updated.aspectVerdicts).toBeUndefined();
    expect(updated.structureTouchedFiles?.s1?.['src/a.ts']).toBe('hh');
  });
});
