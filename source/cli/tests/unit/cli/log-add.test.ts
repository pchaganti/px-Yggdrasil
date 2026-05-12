import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { logAddCommand } from '../../../src/cli/log-add.js';

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

async function setupNode(name: string): Promise<{ projectRoot: string; nodePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-logadd-'));
  dirs.push(root);
  const nodeDir = path.join(root, '.yggdrasil', 'model', name);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), `name: ${name}\ntype: module\ndescription: x\n`);
  return { projectRoot: root, nodePath: name };
}

describe('logAddCommand', () => {
  it('creates log.md when not present', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    await logAddCommand({ node: nodePath, reason: 'Initial setup' }, projectRoot);
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const content = await readFile(logPath, 'utf-8');
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\nInitial setup\n$/);
  });

  it('appends directly after existing trailing newline (no blank separator)', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '## [2026-05-11T14:00:00.000Z]\nFirst.\n');
    await logAddCommand({ node: nodePath, reason: 'Second' }, projectRoot);
    const content = await readFile(logPath, 'utf-8');
    expect(content.match(/^## \[/gm)?.length).toBe(2);
    expect(content).toMatch(/First\.\n## \[/);
    expect(content).toMatch(/\nSecond\n$/);
  });

  it('append-then-approve preserves integrity baseline byte-stability', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await logAddCommand({ node: nodePath, reason: 'first' }, projectRoot);
    const afterFirst = await readFile(logPath, 'utf-8');
    const { parseLog } = await import('../../../src/io/log-parser.js');
    const entriesAfterFirst = parseLog(afterFirst);
    expect(entriesAfterFirst).toHaveLength(1);
    const baselineOffsetEnd = entriesAfterFirst[0].offsetEnd;
    expect(baselineOffsetEnd).toBe(Buffer.byteLength(afterFirst, 'utf-8'));

    await logAddCommand({ node: nodePath, reason: 'second' }, projectRoot);
    const afterSecond = await readFile(logPath, 'utf-8');
    const entriesAfterSecond = parseLog(afterSecond);
    expect(entriesAfterSecond).toHaveLength(2);
    expect(entriesAfterSecond[0].offsetEnd).toBe(baselineOffsetEnd);
  });

  it('auto-bumps datetime when current time <= last entry', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const future = new Date(Date.now() + 60_000).toISOString();
    await writeFile(logPath, `## [${future}]\nFuture.\n`);
    await logAddCommand({ node: nodePath, reason: 'Now' }, projectRoot);
    const content = await readFile(logPath, 'utf-8');
    const headers = [...content.matchAll(/^## \[(.+?)\]/gm)].map((m) => m[1]);
    expect(headers).toHaveLength(2);
    expect(headers[1] > headers[0]).toBe(true);
  });

  it('rejects empty --reason after trim', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath, reason: '   ' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringMatching(/reason.*empty/i),
    );
  });

  it('rejects --reason with level-2 header outside fence', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath, reason: 'intro\n## stray\n' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('accepts --reason with level-2 header INSIDE fence', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    await expect(
      logAddCommand(
        { node: nodePath, reason: 'before\n```python\n## comment\n```\nafter' },
        projectRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects symlink log.md', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const target = path.join(projectRoot, 'real.md');
    await writeFile(target, '');
    await symlink(target, logPath);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath, reason: 'x' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('rejects hardlink log.md (st_nlink > 1)', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const other = path.join(projectRoot, 'other.md');
    await writeFile(logPath, '');
    await link(logPath, other);
    const s = await lstat(logPath);
    expect(s.nlink).toBe(2);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath, reason: 'x' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('rejects invalid --node path (..)', async () => {
    const { projectRoot } = await setupNode('billing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: '../escape', reason: 'x' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('rejects when node does not exist (no yg-node.yaml)', async () => {
    const { projectRoot } = await setupNode('billing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: 'missing', reason: 'x' }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('accepts --reason-file as alternative', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const reasonFile = path.join(projectRoot, 'reason.txt');
    await writeFile(reasonFile, 'multi\nline\ncontent');
    await logAddCommand({ node: nodePath, reasonFile }, projectRoot);
    const content = await readFile(
      path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md'),
      'utf-8',
    );
    expect(content).toContain('multi\nline\ncontent');
  });

  it('rejects when both --reason and --reason-file provided', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    const reasonFile = path.join(projectRoot, 'r.txt');
    await writeFile(reasonFile, 'x');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath, reason: 'a', reasonFile }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });

  it('rejects when neither --reason nor --reason-file provided', async () => {
    const { projectRoot, nodePath } = await setupNode('billing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      logAddCommand({ node: nodePath }, projectRoot),
    ).rejects.toThrow('process.exit:1');
  });
});
