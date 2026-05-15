import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateTo44 } from '../../../src/migrations/to-4.4.0.js';

describe('migrateTo44', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mig44-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses when version is missing', async () => {
    writeFileSync(join(tmpDir, 'yg-config.yaml'), 'parallel: 1\n');
    await expect(migrateTo44(tmpDir)).rejects.toThrow(/yg-config.yaml.*version/);
  });

  it('writes version 4.4.0 to yg-config.yaml from 4.3.0', async () => {
    writeFileSync(join(tmpDir, 'yg-config.yaml'), 'version: "4.3.0"\nparallel: 1\n');
    const result = await migrateTo44(tmpDir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/4\.4\.0/);
    const after = readFileSync(join(tmpDir, 'yg-config.yaml'), 'utf-8');
    expect(after).toMatch(/^version: "4\.4\.0"/m);
    expect(after).toMatch(/parallel: 1/);
  });

  it('writes version 4.4.0 to yg-config.yaml from 4.0.0 (orchestrator path)', async () => {
    writeFileSync(join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\n');
    const result = await migrateTo44(tmpDir);
    const after = readFileSync(join(tmpDir, 'yg-config.yaml'), 'utf-8');
    expect(after).toMatch(/^version: "4\.4\.0"/m);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('returns actions list with version change description', async () => {
    writeFileSync(join(tmpDir, 'yg-config.yaml'), 'version: "4.3.0"\n');
    const result = await migrateTo44(tmpDir);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]).toMatch(/4\.3\.0.*4\.4\.0/);
  });
});
