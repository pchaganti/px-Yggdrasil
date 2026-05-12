import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { logReadCommand } from '../../../src/cli/log-read.js';

const dirs: string[] = [];

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit:${code}`);
  });
});

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupNode(
  name: string,
  logContent?: string,
): Promise<{ projectRoot: string; nodePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-logread-'));
  dirs.push(root);
  const nodeDir = path.join(root, '.yggdrasil', 'model', name);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), `name: ${name}\ntype: module\ndescription: x\n`);
  if (logContent !== undefined) {
    await writeFile(path.join(nodeDir, 'log.md'), logContent);
  }
  return { projectRoot: root, nodePath: name };
}

describe('logReadCommand', () => {
  it('emits "No log entries." when file missing', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
    await logReadCommand({ node: nodePath }, projectRoot);
    expect(out.join('')).toMatch(/No log entries/);
  });

  it('default --top is 10', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
    await logReadCommand({ node: nodePath }, projectRoot);
    const matches = out.join('').match(/^## \[/gm) ?? [];
    expect(matches.length).toBe(10);
  });

  it('--top 3 returns 3 newest first', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
    await logReadCommand({ node: nodePath, top: 3 }, projectRoot);
    const printed = out.join('');
    expect(printed.indexOf('entry 4')).toBeLessThan(printed.indexOf('entry 2'));
    const matches = printed.match(/^## \[/gm) ?? [];
    expect(matches.length).toBe(3);
  });

  it('--all returns all entries', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => {
      const ms = String(i).padStart(3, '0');
      return `## [2026-05-11T14:23:00.${ms}Z]\nentry ${i}\n`;
    }).join('');
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
    await logReadCommand({ node: nodePath, all: true }, projectRoot);
    const matches = out.join('').match(/^## \[/gm) ?? [];
    expect(matches.length).toBe(15);
  });

  it('rejects --top with --all', async () => {
    const { projectRoot, nodePath } = await setupNode(
      'billing',
      '## [2026-05-11T14:23:00.000Z]\nx\n',
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logReadCommand({ node: nodePath, top: 5, all: true }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('--top N > total returns all', async () => {
    const entries = '## [2026-05-11T14:23:00.000Z]\nonly.\n';
    const { projectRoot, nodePath } = await setupNode('billing', entries);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
      out.push(String(s));
      return true;
    });
    await logReadCommand({ node: nodePath, top: 99 }, projectRoot);
    const matches = out.join('').match(/^## \[/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it('rejects --top 0 or negative', async () => {
    const { projectRoot, nodePath } = await setupNode(
      'billing',
      '## [2026-05-11T14:23:00.000Z]\nx\n',
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logReadCommand({ node: nodePath, top: 0 }, projectRoot),
    ).rejects.toThrow('process.exit:1');
    await expect(
      logReadCommand({ node: nodePath, top: -3 }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('format violation → stderr and exit 1', async () => {
    const bad = 'garbage\n## [bad]\ncontent\n';
    const { projectRoot, nodePath } = await setupNode('billing', bad);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logReadCommand({ node: nodePath, top: 10 }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });
});
