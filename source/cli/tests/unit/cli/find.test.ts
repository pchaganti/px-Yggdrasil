import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { findCommand } from '../../../src/cli/find.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupGraph(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-find-cli-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model', 'billing', 'cancel'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'end-of-period'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.3.0"\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: cmd\n');
  await writeFile(
    path.join(yggRoot, 'model', 'billing', 'yg-node.yaml'),
    'name: billing\ntype: command\ndescription: Billing module\n',
  );
  await writeFile(
    path.join(yggRoot, 'model', 'billing', 'cancel', 'yg-node.yaml'),
    'name: cancel\ntype: command\ndescription: Subscription cancellation workflow\n',
  );
  await writeFile(
    path.join(yggRoot, 'aspects', 'end-of-period', 'yg-aspect.yaml'),
    'name: End of period\ndescription: cancellation policy\n',
  );
  return root;
}

describe('findCommand', () => {
  it('prints top results with Kind line', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('subscription cancellation', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('Kind: node');
    expect(printed).toMatch(/model\/billing\/cancel\//);
  });

  it('emits "No matches." when query has no hit', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('zzzzzzz nothing here', root);
    expect(exit).toBe(0);
    expect(out.join('')).toMatch(/No matches/);
  });

  it('limits to top 5 results', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('billing cancellation policy module', root);
    const printed = out.join('');
    const matches = printed.match(/^\d+\./gm) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it('handles empty graph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-find-empty-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.3.0"\n');
    await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: c\n');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('anything', root);
    expect(exit).toBe(0);
    expect(out.join('')).toMatch(/Empty graph|No matches/);
  });

  it('returns exit 1 on empty query', async () => {
    const root = await setupGraph();
    const exit = await findCommand('', root);
    expect(exit).toBe(1);
  });
});
