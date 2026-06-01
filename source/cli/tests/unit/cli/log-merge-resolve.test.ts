import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { logMergeResolve } from '../../../src/core/log/log-merge-resolve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
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

describe('logMergeResolve (core)', () => {
  it('accepts byte-exact ancestor prefix + union of new entries', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    const prefixHash = createHash('sha256').update(Buffer.from(ANCESTOR_LOG, 'utf-8')).digest('hex');
    await writeNodeDriftState(yggRoot, nodePath, {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'h',
      files: {},
      identity: { ownSubset: 'o', ports: {}, aspects: {} },
      aspectVerdicts: {},
      log: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: prefixHash },
    });
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
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
    const graph = await loadGraph(repo, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'billing', repoRoot: repo });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('not a merge commit');
  });

  it('rejects when log.md still has conflict markers', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await writeFile(logPath, '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat\n');
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('conflict markers');
  });

  it('rejects when old portion modified vs ancestor', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const tampered =
      '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    await writeFile(logPath, tampered);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('ancestor prefix');
  });

  it('rejects when new entries dropped (union missing)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const missing = ANCESTOR_LOG + '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, missing);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('missing');
  });

  it('rejects a fabricated entry not present in either merge parent', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const fabricated =
      ANCESTOR_LOG +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T13:00:00.000Z]\nFABRICATED — never written on either branch.\n';
    await writeFile(logPath, fabricated);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('rejects an altered entry body (same timestamp, changed text)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const altered =
      ANCESTOR_LOG +
      '## [2026-05-11T11:00:00.000Z]\nALTERED feat1 body — tampered after the fact.\n' +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n';
    await writeFile(logPath, altered);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('returns a structured error when log.md is absent (no unexpected throw)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    await rm(logPath);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toMatch(/log\.md/);
  });

  it('rejects when new entries out of chronological order', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const outOfOrder =
      ANCESTOR_LOG +
      '## [2026-05-11T12:00:00.000Z]\nfeat2.\n' +
      '## [2026-05-11T11:00:00.000Z]\nfeat1.\n';
    await writeFile(logPath, outOfOrder);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('chronological');
  });

  it('rejects invalid node path (..)', async () => {
    const { projectRoot } = await setupMergeRepo();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: '../escape', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
  });

  it('rejects when node does not exist', async () => {
    const { projectRoot } = await setupMergeRepo();
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath: 'nonexistent', repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('Node not found');
  });

  // D5: plural-count message branches + the no-prior-baseline write path.

  it('reports the plural "entries" form when MULTIPLE parent entries are missing', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    // Drop BOTH new entries (feat1 + feat2) — only the ancestor remains.
    await writeFile(logPath, ANCESTOR_LOG);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('missing or has altered 2 entries');
  });

  it('reports the plural "entries" form when MULTIPLE fabricated entries are present', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    const logPath = path.join(projectRoot, '.yggdrasil', 'model', nodePath, 'log.md');
    const twoFabricated =
      RESOLVED_LOG_GOOD +
      '## [2026-05-11T13:00:00.000Z]\nfab one.\n' +
      '## [2026-05-11T14:00:00.000Z]\nfab two.\n';
    await writeFile(logPath, twoFabricated);
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.what).toContain('2 new entries not present');
  });

  it('accepts a valid merge even when NO prior drift-state baseline exists (writes a fresh one)', async () => {
    const { projectRoot, nodePath } = await setupMergeRepo();
    // No writeNodeDriftState here — the resolved log is a valid union, and the
    // merge-resolve must succeed, creating the baseline from scratch.
    const graph = await loadGraph(projectRoot, { tolerateInvalidConfig: true });
    const result = await logMergeResolve({ graph, nodePath, repoRoot: projectRoot });
    expect(result.ok).toBe(true);
  });
});
