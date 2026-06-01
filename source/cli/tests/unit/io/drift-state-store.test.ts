import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDriftState,
  writeDriftState,
  readNodeDriftState,
  writeNodeDriftState,
  garbageCollectDriftState,
  OutdatedDriftBaselineError,
} from '../../../src/io/drift-state-store.js';
import type { DriftState, DriftNodeState, DriftIdentity } from '../../../src/model/drift.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

const EMPTY_IDENTITY: DriftIdentity = { ownSubset: 'h-own', ports: {}, aspects: {} };

/** Build a complete typed DriftNodeState for tests. */
function makeState(over: Partial<DriftNodeState> = {}): DriftNodeState {
  return {
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    hash: 'abc123',
    files: {},
    identity: EMPTY_IDENTITY,
    aspectVerdicts: {},
    ...over,
  };
}

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-drift'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('drift-state-store', () => {
  it('reads existing drift state from per-node directory format', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-read');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const state: DriftState = {
      'orders/order-service': makeState({ hash: 'abc123def456', files: { 'src/orders/order.service.ts': 'abc123def456' } }),
      'auth/auth-api': makeState({ hash: 'fff789', files: { 'src/auth/auth.controller.ts': 'fff789' } }),
    };
    await writeDriftState(tmpDir, state);

    const result = await readDriftState(tmpDir);

    expect(result['orders/order-service']).toEqual(state['orders/order-service']);
    expect(result['auth/auth-api']).toEqual(state['auth/auth-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when file does not exist', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-none');
    await mkdir(tmpDir, { recursive: true });

    const state = await readDriftState(tmpDir);

    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writeDriftState creates/updates per-node files correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-write');
    await mkdir(tmpDir, { recursive: true });

    const state: DriftState = {
      'test/node': makeState({ hash: 'abc123', files: { 'src/test.ts': 'abc123' } }),
    };

    await writeDriftState(tmpDir, state);

    const content = await readFile(path.join(tmpDir, '.drift-state', 'test', 'node.json'), 'utf-8');
    expect(content).toContain('abc123');
    expect(content).toContain('"schemaVersion": 1');

    const readBack = await readDriftState(tmpDir);
    expect(readBack['test/node']).toEqual(state['test/node']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a fully-populated typed baseline', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-typed-roundtrip');
    await mkdir(tmpDir, { recursive: true });

    const state = makeState({
      hash: 'canon',
      files: { 'src/a.ts': 'ha' },
      mtimes: { 'src/a.ts': 1717000000000 },
      identity: {
        ownSubset: 'h-own',
        ports: { 'pay/svc': 'h-port' },
        aspects: {
          'my-aspect': { meta: 'h-meta', tier: 'h-tier' },
          'det-aspect': { meta: 'h-det', checkTouched: { 'src/x.ts': 'h-x' } },
        },
      },
      aspectVerdicts: {
        'my-aspect': { verdict: 'approved' },
        'det-aspect': { verdict: 'refused', reason: 'r', errorSource: 'codeViolation' },
      },
      log: { last_entry_datetime: '2026-05-11T14:23:00.123Z', prefix_hash: 'h-log' },
    });

    await writeNodeDriftState(tmpDir, 'svc', state);
    const readBack = await readNodeDriftState(tmpDir, 'svc');
    expect(readBack).toEqual(state);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a baseline with an unknown schemaVersion (99) pointing at --upgrade', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-bad-version');
    const driftDir = path.join(tmpDir, '.drift-state');
    await mkdir(driftDir, { recursive: true });
    await writeFile(
      path.join(driftDir, 'svc.json'),
      JSON.stringify({ schemaVersion: 99, hash: 'x', files: {}, identity: EMPTY_IDENTITY, aspectVerdicts: {} }),
      'utf-8',
    );

    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.toThrow(OutdatedDriftBaselineError);
    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.toThrow(/yg init --upgrade/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a baseline with an absent schemaVersion (predates the typed format)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-no-version');
    const driftDir = path.join(tmpDir, '.drift-state');
    await mkdir(driftDir, { recursive: true });
    // Old flat baseline — no schemaVersion.
    await writeFile(
      path.join(driftDir, 'svc.json'),
      JSON.stringify({ hash: 'x', files: { 'src/a.ts': 'ha' } }),
      'utf-8',
    );

    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.toThrow(OutdatedDriftBaselineError);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a corrupt v1 baseline (correct schemaVersion but missing fields) with restore-or-delete advice, NOT --upgrade', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-corrupt-v1');
    const driftDir = path.join(tmpDir, '.drift-state');
    await mkdir(driftDir, { recursive: true });
    // schemaVersion is current (1), but required fields are absent — simulates hand-editing.
    await writeFile(
      path.join(driftDir, 'svc.json'),
      JSON.stringify({ schemaVersion: DRIFT_STATE_SCHEMA_VERSION }),
      'utf-8',
    );

    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.not.toThrow(OutdatedDriftBaselineError);
    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.toThrow(/re-run `yg approve --node/);
    // Must NOT suggest yg init --upgrade for a corrupt-current-version baseline
    await expect(readNodeDriftState(tmpDir, 'svc')).rejects.not.toThrow(/yg init --upgrade/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when .drift-state is a file instead of directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-file-fallback');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, '.drift-state'), 'orders/order-service:\n  hash: x\n', 'utf-8');

    const state = await readDriftState(tmpDir);
    expect(Object.keys(state)).toHaveLength(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('write and read roundtrip', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-roundtrip');
    await mkdir(tmpDir, { recursive: true });

    const state: DriftState = {
      'multi/svc': makeState({ hash: 'sha256abc123', files: { 'src/multi.ts': 'sha256abc123' } }),
      'other/node': makeState({ hash: 'sha256def456', files: { 'src/other.ts': 'sha256def456' } }),
    };

    await writeDriftState(tmpDir, state);
    const readBack = await readDriftState(tmpDir);
    expect(readBack['multi/svc']).toEqual(state['multi/svc']);
    expect(readBack['other/node']).toEqual(state['other/node']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Per-node drift state tests ---

  it('writeNodeDriftState creates file at correct nested path', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-write');
    await mkdir(tmpDir, { recursive: true });

    const nodeState = makeState({ hash: 'abc123', files: { 'src/test.ts': 'abc123' } });
    await writeNodeDriftState(tmpDir, 'cli/commands/aspects', nodeState);

    const content = await readFile(
      path.join(tmpDir, '.drift-state', 'cli', 'commands', 'aspects.json'),
      'utf-8',
    );
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(nodeState);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readNodeDriftState reads per-node file correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-read');
    const stateDir = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    await mkdir(stateDir, { recursive: true });

    const nodeState = makeState({ hash: 'def456', files: { 'src/cmd.ts': 'def456' }, mtimes: { 'src/cmd.ts': 1234567890 } });
    await writeFile(path.join(stateDir, 'aspects.json'), JSON.stringify(nodeState), 'utf-8');

    const result = await readNodeDriftState(tmpDir, 'cli/commands/aspects');
    expect(result).toEqual(nodeState);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readNodeDriftState returns undefined for missing file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-missing');
    await mkdir(tmpDir, { recursive: true });

    const result = await readNodeDriftState(tmpDir, 'nonexistent/node');
    expect(result).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState reads from per-node directory (multiple files)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-dir');
    const dir1 = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    const dir2 = path.join(tmpDir, '.drift-state', 'cli', 'core');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    const state1 = makeState({ hash: 'aaa', files: { 'src/a.ts': 'aaa' } });
    const state2 = makeState({ hash: 'bbb', files: { 'src/b.ts': 'bbb' } });
    await writeFile(path.join(dir1, 'aspects.json'), JSON.stringify(state1), 'utf-8');
    await writeFile(path.join(dir2, 'loader.json'), JSON.stringify(state2), 'utf-8');

    const result = await readDriftState(tmpDir);
    expect(result['cli/commands/aspects']).toEqual(state1);
    expect(result['cli/core/loader']).toEqual(state2);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writeNodeDriftState pretty-prints JSON', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-per-node-pretty');
    await mkdir(tmpDir, { recursive: true });

    const nodeState = makeState({ hash: 'abc123', files: { 'src/test.ts': 'abc123' } });
    await writeNodeDriftState(tmpDir, 'test/node', nodeState);

    const content = await readFile(
      path.join(tmpDir, '.drift-state', 'test', 'node.json'),
      'utf-8',
    );
    expect(content).toContain('\n');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).toContain('  "hash"');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState removes orphaned files, keeps valid ones', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc');
    const dir1 = path.join(tmpDir, '.drift-state', 'cli', 'commands');
    const dir2 = path.join(tmpDir, '.drift-state', 'cli', 'core');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    const s = JSON.stringify(makeState());
    await writeFile(path.join(dir1, 'aspects.json'), s, 'utf-8');
    await writeFile(path.join(dir1, 'orphan.json'), s, 'utf-8');
    await writeFile(path.join(dir2, 'loader.json'), s, 'utf-8');

    const validPaths = new Set(['cli/commands/aspects', 'cli/core/loader']);
    const removed = await garbageCollectDriftState(tmpDir, validPaths);

    expect(removed).toEqual(['cli/commands/orphan']);

    const kept1 = await readFile(path.join(dir1, 'aspects.json'), 'utf-8');
    expect(kept1).toBeTruthy();
    const kept2 = await readFile(path.join(dir2, 'loader.json'), 'utf-8');
    expect(kept2).toBeTruthy();

    await expect(readFile(path.join(dir1, 'orphan.json'), 'utf-8')).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState removes empty parent directories after GC', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc-dirs');
    const orphanDir = path.join(tmpDir, '.drift-state', 'orphan', 'deep');
    const validDir = path.join(tmpDir, '.drift-state', 'valid');
    await mkdir(orphanDir, { recursive: true });
    await mkdir(validDir, { recursive: true });

    const s = JSON.stringify(makeState());
    await writeFile(path.join(orphanDir, 'node.json'), s, 'utf-8');
    await writeFile(path.join(validDir, 'node.json'), s, 'utf-8');

    const validPaths = new Set(['valid/node']);
    const removed = await garbageCollectDriftState(tmpDir, validPaths);

    expect(removed).toEqual(['orphan/deep/node']);

    const { stat: fsStat } = await import('node:fs/promises');
    await expect(fsStat(orphanDir)).rejects.toThrow();
    await expect(fsStat(path.join(tmpDir, '.drift-state', 'orphan'))).rejects.toThrow();

    const validStat = await fsStat(validDir);
    expect(validStat.isDirectory()).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState ignores non-json files in drift-state directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-non-json');
    const driftDir = path.join(tmpDir, '.drift-state');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(driftDir, { recursive: true });

    await writeFile(path.join(driftDir, 'valid-node.json'), JSON.stringify(makeState()), 'utf-8');
    await writeFile(path.join(driftDir, 'readme.txt'), 'not a drift state file', 'utf-8');

    const result = await readDriftState(tmpDir);
    expect(Object.keys(result)).toEqual(['valid-node']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('readDriftState skips corrupt json files gracefully', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-corrupt');
    const driftDir = path.join(tmpDir, '.drift-state');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(driftDir, { recursive: true });

    // Unparseable JSON → skipped (returns undefined), not a thrown error.
    await writeFile(path.join(driftDir, 'corrupt-node.json'), 'not valid json{{{', 'utf-8');
    await writeFile(path.join(driftDir, 'good-node.json'), JSON.stringify(makeState({ hash: 'bbb' })), 'utf-8');

    const result = await readDriftState(tmpDir);
    expect(result['corrupt-node']).toBeUndefined();
    expect(result['good-node']).toEqual(makeState({ hash: 'bbb' }));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('garbageCollectDriftState handles non-existent drift-state directory', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-gc-nodir');
    await mkdir(tmpDir, { recursive: true });

    const removed = await garbageCollectDriftState(tmpDir, new Set());
    expect(removed).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });

});

describe('garbageCollectDriftState — shouldKeep predicate', () => {
  it('removes drift file when shouldKeep returns false even though node is in graph', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-drift-should-keep');
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await writeNodeDriftState(tmpDir, 'a', makeState({ hash: 'h' }));
    await writeNodeDriftState(tmpDir, 'b', makeState({ hash: 'h' }));

    const removed = await garbageCollectDriftState(
      tmpDir,
      new Set(['a', 'b']),
      (nodePath) => nodePath !== 'b',
    );
    expect(removed).toContain('b');

    const remaining = await readDriftState(tmpDir);
    expect(Object.keys(remaining).sort()).toEqual(['a']);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
