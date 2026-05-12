import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, link, rename } from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode, commitApproval } from '../../../src/core/approve.js';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function sha(s: string) {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

async function setup(opts: {
  logRequiredOnModule?: boolean;
  initialLogContent?: string;
  initialBaseline?: { last_entry_datetime: string; prefix_hash: string };
  sourceContent?: string;
  initialSourceHash?: string;
}): Promise<{ projectRoot: string; nodePath: string; logPath: string; sourcePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-approve-log-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'a1'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.2.0"\n');
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  module:\n    description: m\n    log_required: ${opts.logRequiredOnModule ?? true}\n`,
  );
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'yg-aspect.yaml'), 'name: A1\ndescription: x\n');
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'content.md'), 'rule.\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: svc\ntype: module\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - a1\n`,
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), opts.sourceContent ?? 'export const x = 1;\n');
  if (opts.initialLogContent !== undefined) {
    await writeFile(path.join(nodeDir, 'log.md'), opts.initialLogContent);
  }
  if (opts.initialBaseline !== undefined || opts.initialSourceHash !== undefined) {
    await writeNodeDriftState(yggRoot, 'svc', {
      hash: opts.initialSourceHash ?? 'h',
      files:
        opts.initialSourceHash !== undefined
          ? {
              'src/svc.ts': opts.initialSourceHash,
              '.yggdrasil/model/svc/yg-node.yaml': 'h-yaml',
              '.yggdrasil/aspects/a1/content.md': 'h-asp',
            }
          : {},
      log: opts.initialBaseline,
    });
  }
  return {
    projectRoot: root,
    nodePath: 'svc',
    logPath: path.join(nodeDir, 'log.md'),
    sourcePath: path.join(root, 'src', 'svc.ts'),
  };
}

describe('approveNode — log integration', () => {
  it('refuses on integrity break (prefix_modified)', async () => {
    const e1 = '## [2026-05-11T10:00:00.000Z]\norig.\n';
    const tampered = '## [2026-05-11T10:00:00.000Z]\ntampered.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(e1) };
    const { projectRoot, nodePath } = await setup({
      initialLogContent: tampered,
      initialBaseline: baseline,
      initialSourceHash: 'will-mismatch-source',
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/integrity|prefix_modified/i);
  });

  it('refuses on format violation (level2 header in body)', async () => {
    const bad = '## [2026-05-11T10:00:00.000Z]\nintro.\n## stray.\n';
    const { projectRoot, nodePath } = await setup({
      initialLogContent: bad,
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/format/i);
  });

  it('refuses on missing mandatory entry when source changed and log_required true', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nentry.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(log) };
    const { projectRoot, nodePath, sourcePath } = await setup({
      initialLogContent: log,
      initialBaseline: baseline,
      initialSourceHash: 'h-old',
    });
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/no log entry|mandatory/i);
  });

  it('approves when log entry added after source change', async () => {
    const initialLog = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(initialLog) };
    const { projectRoot, nodePath, logPath, sourcePath } = await setup({
      initialLogContent: initialLog,
      initialBaseline: baseline,
      initialSourceHash: 'h-old',
    });
    await writeFile(sourcePath, 'export const x = 2;\n');
    const newLog = initialLog + '## [2026-05-11T11:00:00.000Z]\nupdated.\n';
    await writeFile(logPath, newLog);
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('approved');
    expect(result.pendingDriftState?.state.log?.last_entry_datetime).toBe('2026-05-11T11:00:00.000Z');
  });

  it('log_required: false skips mandatory entry check', async () => {
    const { projectRoot, nodePath, sourcePath } = await setup({
      logRequiredOnModule: false,
      initialSourceHash: 'h-old',
    });
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('approved');
  });

  it('cascade approve (aspect changed, no source drift) skips mandatory check', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(log) };
    const { projectRoot, nodePath } = await setup({
      initialLogContent: log,
      initialBaseline: baseline,
      initialSourceHash: 'will-match-via-update',
    });
    const yggRoot = path.join(projectRoot, '.yggdrasil');
    const srcHash = sha('export const x = 1;\n');
    await writeNodeDriftState(yggRoot, nodePath, {
      hash: 'h',
      files: {
        'src/svc.ts': srcHash,
        '.yggdrasil/model/svc/yg-node.yaml': 'h-stale-yaml',
        '.yggdrasil/aspects/a1/content.md': sha('rule.\n'),
      },
      log: baseline,
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('approved');
    expect(result.changedSource).toBeUndefined();
    expect(result.pendingDriftState?.state.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('refuses when log.md missing but baseline exists (boundary_missing)', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(log) };
    const { projectRoot, nodePath, logPath } = await setup({
      initialLogContent: log,
      initialBaseline: baseline,
      initialSourceHash: 'h-old',
    });
    await rm(logPath);
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/integrity|boundary_missing/i);
  });

  it('refuses when log.md is a symlink', async () => {
    const { projectRoot, nodePath, logPath } = await setup({
      initialLogContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const real = logPath + '.real';
    await rename(logPath, real);
    await symlink(real, logPath);
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/symlink/i);
  });

  it('refuses when log.md has hard links', async () => {
    const { projectRoot, nodePath, logPath } = await setup({
      initialLogContent: '## [2026-05-11T10:00:00.000Z]\nfirst.\n',
    });
    const extra = logPath + '.link';
    await link(logPath, extra);
    dirs.push(extra);
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/hard link/i);
    await rm(extra);
  });

  it('format violation with baseline → post-baseline zone (editable)', async () => {
    const e1 = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const e2bad = '## [2026-05-11T11:00:00.000Z]\nbody.\n## bad header.\n';
    const log = e1 + e2bad;
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(e1) };
    const { projectRoot, nodePath } = await setup({
      initialLogContent: log,
      initialBaseline: baseline,
      initialSourceHash: 'h',
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/format/i);
    expect(result.refuseReason).toMatch(/Post-baseline/i);
  });

  it('format violation in pre-baseline zone (history modified)', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nbody.\n## bad header.\n';
    const baseline = { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(log) };
    const { projectRoot, nodePath } = await setup({
      initialLogContent: log,
      initialBaseline: baseline,
      initialSourceHash: 'h',
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/format/i);
    expect(result.refuseReason).toMatch(/Pre-baseline/i);
  });

  it('commitApproval persists log baseline alongside files map', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot, nodePath } = await setup({
      initialLogContent: log,
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('initial');
    await commitApproval(path.join(projectRoot, '.yggdrasil'), result);
    const stored = await readNodeDriftState(path.join(projectRoot, '.yggdrasil'), nodePath);
    expect(stored?.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
    expect(stored?.log?.prefix_hash).toBeTypeOf('string');
  });
});

describe('approveNode — logical node (no mapping)', () => {
  async function setupLogical(opts: {
    logContent?: string;
  }): Promise<{ projectRoot: string; nodePath: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-logical-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    const nodeDir = path.join(yggRoot, 'model', 'mod');
    await mkdir(nodeDir, { recursive: true });
    await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.2.0"\n');
    await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  module:\n    description: m\n');
    await writeFile(path.join(nodeDir, 'yg-node.yaml'), 'name: mod\ntype: module\ndescription: x\n');
    if (opts.logContent !== undefined) {
      await writeFile(path.join(nodeDir, 'log.md'), opts.logContent);
    }
    return { projectRoot: root, nodePath: 'mod' };
  }

  it('approves no-mapping node with log.md — log-only baseline', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nReorganized.\n';
    const { projectRoot, nodePath } = await setupLogical({ logContent: log });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('initial');
    expect(result.pendingDriftState?.state.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('rejects no-mapping node without log.md (nothing to approve)', async () => {
    const { projectRoot, nodePath } = await setupLogical({});
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(result.refuseReason).toMatch(/no mapping|no log/i);
  });
});
