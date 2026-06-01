import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeNodeDriftState,
  readNodeDriftState,
  clearDraftAspectsFromDriftState,
} from '../../../src/io/drift-state-store.js';
import type { DriftNodeState } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

const tmpDirs: string[] = [];

function makeState(over: Partial<DriftNodeState> = {}): DriftNodeState {
  return {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: 'abc',
    files: {},
    identity: { ownSubset: 'o', ports: {}, aspects: {} },
    aspectVerdicts: {},
    ...over,
  };
}

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('clearDraftAspectsFromDriftState', () => {
  it('removes only specified aspect keys', async () => {
    const dir = await makeTmp();
    const yggRoot = join(dir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    const state = makeState({
      aspectVerdicts: {
        'audit-log': { verdict: 'approved' },
        'old-experimental': { verdict: 'refused', reason: 'x', errorSource: 'codeViolation' },
      },
    });
    await writeNodeDriftState(yggRoot, 'orders/handler', state);
    await clearDraftAspectsFromDriftState(yggRoot, 'orders/handler', new Set(['old-experimental']));
    const after = await readNodeDriftState(yggRoot, 'orders/handler');
    expect(Object.keys(after?.aspectVerdicts ?? {})).toEqual(['audit-log']);
  });

  it('no-op when no overlap with stored aspects', async () => {
    const dir = await makeTmp();
    const yggRoot = join(dir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    const state = makeState({ aspectVerdicts: { a: { verdict: 'approved' } } });
    await writeNodeDriftState(yggRoot, 'n', state);
    await clearDraftAspectsFromDriftState(yggRoot, 'n', new Set(['nonexistent']));
    const after = await readNodeDriftState(yggRoot, 'n');
    expect(Object.keys(after?.aspectVerdicts ?? {})).toEqual(['a']);
  });

  it('no-op when stored aspectVerdicts is already empty', async () => {
    const dir = await makeTmp();
    const yggRoot = join(dir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    await writeNodeDriftState(yggRoot, 'n', makeState());
    await clearDraftAspectsFromDriftState(yggRoot, 'n', new Set(['anything']));
    const after = await readNodeDriftState(yggRoot, 'n');
    expect(after?.aspectVerdicts).toEqual({});
  });

  it('retains an empty aspectVerdicts map (required field) when all entries removed', async () => {
    const dir = await makeTmp();
    const yggRoot = join(dir, '.yggdrasil');
    await mkdir(yggRoot, { recursive: true });
    const state = makeState({ aspectVerdicts: { a: { verdict: 'approved' } } });
    await writeNodeDriftState(yggRoot, 'n', state);
    await clearDraftAspectsFromDriftState(yggRoot, 'n', new Set(['a']));
    const after = await readNodeDriftState(yggRoot, 'n');
    expect(after?.aspectVerdicts).toEqual({});
  });
});
