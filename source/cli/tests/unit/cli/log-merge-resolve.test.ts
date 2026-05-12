import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { logMergeResolveCommand } from '../../../src/cli/log-merge-resolve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';

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

const ANCESTOR_LOG = '## [2026-05-11T10:00:00.000Z]\nbase.\n';
const PARENT1_LOG = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
const PARENT2_LOG = ANCESTOR_LOG + '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
const RESOLVED_LOG_GOOD =
  ANCESTOR_LOG +
  '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
  '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';

async function setupMergeRepo(): Promise<{ projectRoot: string; nodePath: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-'));
  dirs.push(repo);
  const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  r('git init -q -b main');
  r('git config user.email t@t.test');
  r('git config user.name Test');
  const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
  await mkdir(nodeDir, { recursive: true });
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
  await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR_LOG);
  r('git add -A && git commit -qm ancestor');

  r('git checkout -qb feat1');
  await writeFile(path.join(nodeDir, 'log.md'), PARENT1_LOG);
  r('git add -A && git commit -qm feat1');

  r('git checkout -q main && git checkout -qb feat2 main');
  await writeFile(path.join(nodeDir, 'log.md'), PARENT2_LOG);
  r('git add -A && git commit -qm feat2');

  r('git merge --no-commit --no-ff feat1 -q || true');
  await writeFile(path.join(nodeDir, 'log.md'), RESOLVED_LOG_GOOD);
  r('git add -A');
  r('git commit -qm "merge feat1 into feat2"');

  return { projectRoot: repo, nodePath: 'billing' };
}

describe('logMergeResolveCommand', () => {
  it('accepts byte-exact ancestor prefix + union of new entries', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const prefixHash = createHash('sha256').update(Buffer.from(ANCESTOR_LOG, 'utf-8')).digest('hex');
    await writeNodeDriftState(path.join(projectRoot, '.yggdrasil'), nodePath, {
      hash: 'h',
      files: {},
      log: {
        last_entry_datetime: '2026-05-11T10:00:00.000Z',
        prefix_hash: prefixHash,
      },
    });
    await expect(logMergeResolveCommand({ node: nodePath }, projectRoot)).resolves.toBeUndefined();
  });

  it('rejects when HEAD is not a merge commit', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'yg-merge-'));
    dirs.push(repo);
    const r = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
    r('git init -q -b main');
    r('git config user.email t@t.test');
    r('git config user.name Test');
    const nodeDir = path.join(repo, '.yggdrasil', 'model', 'billing');
    await mkdir(nodeDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: billing\ntype: module\ndescription: x\n');
    await writeFile(path.join(nodeDir, 'log.md'), ANCESTOR_LOG);
    r('git add -A && git commit -qm only');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(logMergeResolveCommand({ node: 'billing' }, repo)).rejects.toThrow('process.exit:1');
  });

  it('rejects when log.md still has conflict markers', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat\n');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(logMergeResolveCommand({ node: nodePath }, projectRoot)).rejects.toThrow('process.exit:1');
  });

  it('rejects when old portion modified vs ancestor', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const tampered =
      '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    await writeFile(logPath, tampered);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(logMergeResolveCommand({ node: nodePath }, projectRoot)).rejects.toThrow('process.exit:1');
  });

  it('rejects when new entries dropped (union missing)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const missing = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, missing);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(logMergeResolveCommand({ node: nodePath }, projectRoot)).rejects.toThrow('process.exit:1');
  });

  it('rejects when new entries out of chronological order', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const outOfOrder =
      ANCESTOR_LOG +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, outOfOrder);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(logMergeResolveCommand({ node: nodePath }, projectRoot)).rejects.toThrow('process.exit:1');
  });
});
