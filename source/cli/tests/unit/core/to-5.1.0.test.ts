import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migration } from '../../../src/migrations/to-5.1.0.js';
import { CLI_SUPPORTED_SCHEMA } from '../../../src/core/graph-loader.js';

describe('to-5.1.0 migration', () => {
  let base: string;
  let ygg: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'yg-mig51-'));
    ygg = path.join(base, '.yggdrasil');
    await mkdir(ygg, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('targets 5.1.0', () => {
    expect(migration.to).toBe('5.1.0');
  });

  it('targets exactly the CLI-supported schema version', () => {
    // This is the invariant the `init --upgrade` flow relies on: the latest
    // registered migration advances an outdated graph to the version the CLI
    // declares as supported. Pinned here (where importing the constant is
    // legitimate) so the e2e upgrade test can stay a pure black box — it asserts
    // only the observable effect (version advanced, schemas/ removed, idempotent)
    // without importing the constant.
    expect(migration.to).toBe(CLI_SUPPORTED_SCHEMA);
  });

  it('removes an existing schemas/ directory and reports an action', async () => {
    const schemasDir = path.join(ygg, 'schemas');
    await mkdir(schemasDir, { recursive: true });
    await writeFile(path.join(schemasDir, 'yg-node.yaml'), 'name: x\n', 'utf-8');

    const res = await migration.run(ygg);

    await expect(stat(schemasDir)).rejects.toThrow();
    expect(res.actions.join(' ')).toMatch(/schemas/);
    expect(res.warnings).toEqual([]);
  });

  it('is a no-op (no actions, no warnings) when schemas/ is absent', async () => {
    const res = await migration.run(ygg);
    expect(res.actions).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('is idempotent — a second run after removal still succeeds', async () => {
    await mkdir(path.join(ygg, 'schemas'), { recursive: true });
    await migration.run(ygg);
    await expect(migration.run(ygg)).resolves.toEqual({ actions: [], warnings: [] });
  });
});
