import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { migrateTo43 } from '../../../src/migrations/to-4.3.0.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupYgg(archYaml: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-mig-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(ygg, { recursive: true });
  await writeFile(path.join(ygg, 'yg-architecture.yaml'), archYaml);
  return ygg;
}

describe('migrateTo43', () => {
  it('adds log_required: false to existing types', async () => {
    const ygg = await setupYgg('node_types:\n  command:\n    description: cmd\n  module:\n    description: mod\n');
    const result = await migrateTo43(ygg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-architecture.yaml'), 'utf-8')) as any;
    expect(updated.node_types.command.log_required).toBe(false);
    expect(updated.node_types.module.log_required).toBe(false);
    expect(result.actions.some((a) => a.includes('log_required'))).toBe(true);
  });

  it('preserves explicit log_required: true', async () => {
    const ygg = await setupYgg('node_types:\n  command:\n    description: cmd\n    log_required: true\n');
    await migrateTo43(ygg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-architecture.yaml'), 'utf-8')) as any;
    expect(updated.node_types.command.log_required).toBe(true);
  });

  it('skips when yg-architecture.yaml missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-mig-'));
    dirs.push(root);
    const ygg = path.join(root, '.yggdrasil');
    await mkdir(ygg, { recursive: true });
    const result = await migrateTo43(ygg);
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });
});
