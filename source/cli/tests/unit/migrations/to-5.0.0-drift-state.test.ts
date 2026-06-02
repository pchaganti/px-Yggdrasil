import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { migrateTo50 } from '../../../src/migrations/to-5.0.0.js';
import { computeCanonicalHash } from '../../../src/io/hash.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A clean v4.3 config so the surrounding passes succeed and only drift-state behavior is under test. */
const CONFIG_OK = 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n';

/** Create a `.yggdrasil` dir with just a config file (the drift tests need nothing else). */
async function setupYgg(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-mig50-drift-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(ygg, { recursive: true });
  await writeFile(path.join(ygg, 'yg-config.yaml'), config);
  return ygg;
}

/**
 * Write a drift-state baseline file under `<ygg>/.drift-state/<nodePath>.json`.
 * `body` is serialized verbatim (so tests can write the OLD flat shape, a
 * non-object, or invalid JSON via a raw string).
 */
async function writeBaseline(ygg: string, nodePath: string, body: unknown | string): Promise<void> {
  const file = path.join(ygg, '.drift-state', `${nodePath}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  const content = typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n';
  await writeFile(file, content);
}

async function readBaseline(ygg: string, nodePath: string): Promise<unknown> {
  const file = path.join(ygg, '.drift-state', `${nodePath}.json`);
  return JSON.parse(await readFile(file, 'utf-8'));
}

async function baselineExists(ygg: string, nodePath: string): Promise<boolean> {
  const file = path.join(ygg, '.drift-state', `${nodePath}.json`);
  try {
    await readFile(file, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

describe('migrateTo50 drift-state', () => {
  it('re-keys a flat baseline (each synthetic key kind) into typed format; verdicts preserved; hash lossless', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'svc/handler', {
      hash: 'OLD_HASH',
      files: {
        'src/foo.ts': 'h-foo',
        '.yggdrasil/model/svc/handler/yg-node.yaml': 'h-node',
        'src/other/x.ts': 'h-cross',
        'own-subset:svc/handler': 'h-own',
        'aspect-meta:my-aspect': 'h-meta',
        'tier-identity:my-aspect': 'h-tier',
        'check-touched:det-aspect': 'h-ct-summary-dropped',
        'aspect-meta:det-aspect': 'h-det-meta',
        'port-aspects:payments/svc': 'h-port',
      },
      mtimes: { 'src/foo.ts': 1717000000000 },
      aspectVerdicts: {
        'my-aspect': { verdict: 'approved' },
        'det-aspect': { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
      },
      checkTouchedFiles: { 'det-aspect': { 'src/other/x.ts': 'h-cross' } },
      log: { last_entry_datetime: '2026-05-11T14:23:00.123Z', prefix_hash: 'h-log' },
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.actions.some(a => a.includes('.drift-state/svc/handler.json') && a.includes('re-keyed'))).toBe(true);

    const typed = await readBaseline(ygg, 'svc/handler') as {
      schemaVersion: number;
      hash: string;
      files: Record<string, string>;
      identity: { ownSubset: string; ports: Record<string, string>; aspects: Record<string, unknown> };
      aspectVerdicts: Record<string, unknown>;
      mtimes?: Record<string, number>;
      log?: unknown;
    };

    expect(typed.schemaVersion).toBe(DRIFT_STATE_SCHEMA_VERSION);
    // Only real files survive in `files`.
    expect(typed.files).toEqual({
      'src/foo.ts': 'h-foo',
      '.yggdrasil/model/svc/handler/yg-node.yaml': 'h-node',
      'src/other/x.ts': 'h-cross',
    });
    // Typed identity reconstructed from each synthetic kind.
    expect(typed.identity.ownSubset).toBe('h-own');
    expect(typed.identity.ports).toEqual({ 'payments/svc': 'h-port' });
    expect(typed.identity.aspects['my-aspect']).toEqual({ meta: 'h-meta', tier: 'h-tier' });
    expect(typed.identity.aspects['det-aspect']).toEqual({
      meta: 'h-det-meta',
      checkTouched: { 'src/other/x.ts': 'h-cross' },
    });
    // Pre-existing verdicts preserved unchanged (NOT overwritten by approved-synthesis).
    expect(typed.aspectVerdicts).toEqual({
      'my-aspect': { verdict: 'approved' },
      'det-aspect': { verdict: 'refused', reason: 'bad', errorSource: 'codeViolation' },
    });
    expect(typed.mtimes).toEqual({ 'src/foo.ts': 1717000000000 });
    expect(typed.log).toEqual({ last_entry_datetime: '2026-05-11T14:23:00.123Z', prefix_hash: 'h-log' });
    // Hash recomputed losslessly — matches a fresh canonical computation over
    // files + typed identity + the preserved per-aspect verdicts (now folded so
    // a tampered verdict in a migrated baseline is caught by yg check).
    expect(typed.hash).toBe(
      computeCanonicalHash(typed.files, typed.identity as never, typed.aspectVerdicts as never),
    );
    expect(typed.hash).not.toBe('OLD_HASH');
  });

  it('pre-verdict baseline → aspectVerdicts approved for EXACTLY its identity.aspects ids', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'svc', {
      hash: 'x',
      files: {
        'src/a.ts': 'h-a',
        'own-subset:svc': 'h-own',
        'aspect-meta:alpha': 'h-alpha',
        'aspect-meta:beta': 'h-beta',
        'tier-identity:alpha': 'h-tier',
      },
      // NO aspectVerdicts field — pre-verdict baseline.
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);

    const typed = await readBaseline(ygg, 'svc') as { aspectVerdicts: Record<string, unknown> };
    expect(typed.aspectVerdicts).toEqual({
      alpha: { verdict: 'approved' },
      beta: { verdict: 'approved' },
    });
  });

  it('pre-verdict baseline with NO per-aspect identity → leaves {} and warns', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'log-only', {
      hash: 'x',
      files: { 'src/a.ts': 'h-a' },
      // no synthetic keys → identity.aspects empty; no aspectVerdicts field.
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('.drift-state/log-only.json') && w.includes('no per-aspect identity'))).toBe(true);

    const typed = await readBaseline(ygg, 'log-only') as { aspectVerdicts: Record<string, unknown>; schemaVersion: number };
    expect(typed.schemaVersion).toBe(DRIFT_STATE_SCHEMA_VERSION);
    expect(typed.aspectVerdicts).toEqual({});
  });

  it('baseline that already HAS aspectVerdicts: {} is preserved (no approved-synthesis)', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'svc', {
      hash: 'x',
      files: { 'src/a.ts': 'h-a', 'aspect-meta:alpha': 'h-alpha' },
      aspectVerdicts: {}, // present but empty → preserve, do NOT synthesize approved
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings).toEqual([]);
    const typed = await readBaseline(ygg, 'svc') as { aspectVerdicts: Record<string, unknown> };
    expect(typed.aspectVerdicts).toEqual({});
  });

  it('corrupt JSON baseline → deleted + warning naming the file', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'broken', '{ this is not: valid json');
    const result = await migrateTo50(ygg);
    expect(await baselineExists(ygg, 'broken')).toBe(false);
    expect(result.warnings.some(w => w.includes('.drift-state/broken.json') && w.includes('could not be parsed'))).toBe(true);
    expect(result.bumpVersion).toBe(false);
  });

  it('non-object baseline (re-key throws) → deleted + warning', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'scalar', '42');
    const result = await migrateTo50(ygg);
    expect(await baselineExists(ygg, 'scalar')).toBe(false);
    expect(result.warnings.some(w => w.includes('.drift-state/scalar.json') && w.includes('could not be re-keyed'))).toBe(true);
  });

  it('idempotent: an already-typed (schemaVersion:1) baseline is left byte-identical and unwarned', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    // First migrate a flat baseline to typed.
    await writeBaseline(ygg, 'svc', {
      hash: 'x',
      files: { 'src/a.ts': 'h-a', 'own-subset:svc': 'h-own', 'aspect-meta:alpha': 'h-alpha' },
    });
    await migrateTo50(ygg);
    const file = path.join(ygg, '.drift-state', 'svc.json');
    const afterFirst = await readFile(file, 'utf-8');

    // Re-run the whole migration: the typed baseline must not change.
    const result2 = await migrateTo50(ygg);
    const afterSecond = await readFile(file, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    // No drift-state action or warning on the second pass for this file.
    expect(result2.actions.some(a => a.includes('svc.json'))).toBe(false);
    expect(result2.warnings.some(w => w.includes('svc.json'))).toBe(false);
  });

  it('recurses nested node paths and migrates every baseline', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    await writeBaseline(ygg, 'a/b/c', {
      hash: 'x',
      files: { 'src/x.ts': 'h-x', 'aspect-meta:r': 'h-r' },
      aspectVerdicts: { r: { verdict: 'approved' } },
    });
    await writeBaseline(ygg, 'top', {
      hash: 'y',
      files: { 'src/y.ts': 'h-y', 'aspect-meta:s': 'h-s' },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings).toEqual([]);
    const nested = await readBaseline(ygg, 'a/b/c') as { schemaVersion: number };
    const top = await readBaseline(ygg, 'top') as { schemaVersion: number; aspectVerdicts: Record<string, unknown> };
    expect(nested.schemaVersion).toBe(DRIFT_STATE_SCHEMA_VERSION);
    expect(top.schemaVersion).toBe(DRIFT_STATE_SCHEMA_VERSION);
    // 'top' was pre-verdict → approved synthesized for its single aspect.
    expect(top.aspectVerdicts).toEqual({ s: { verdict: 'approved' } });
  });

  it('no .drift-state directory → drift pass is a silent no-op', async () => {
    const ygg = await setupYgg(CONFIG_OK);
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.actions.some(a => a.includes('.drift-state'))).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});
