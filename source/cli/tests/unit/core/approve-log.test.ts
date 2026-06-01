import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, link, rename } from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode, commitApproval } from '../../../src/core/approve.js';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../../src/model/drift.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const refuseMsg = (r: { refuseReasonData?: Parameters<typeof buildIssueMessage>[0] }) =>
  r.refuseReasonData ? buildIssueMessage(r.refuseReasonData) : '';

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

  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');
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
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: opts.initialSourceHash ?? 'h',
      files:
        opts.initialSourceHash !== undefined
          ? {
              'src/svc.ts': opts.initialSourceHash,
              '.yggdrasil/model/svc/yg-node.yaml': 'h-yaml',
              '.yggdrasil/aspects/a1/content.md': 'h-asp',
            }
          : {},
      identity: { ownSubset: 'o', ports: {}, aspects: {} },
      aspectVerdicts: {},
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
    expect(refuseMsg(result)).toMatch(/integrity|prefix_modified/i);
  });

  it('refuses on format violation (level2 header in body)', async () => {
    const bad = '## [2026-05-11T10:00:00.000Z]\nintro.\n## stray.\n';
    const { projectRoot, nodePath } = await setup({
      initialLogContent: bad,
    });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(refuseMsg(result)).toMatch(/format/i);
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
    expect(refuseMsg(result)).toMatch(/no log entry|mandatory/i);
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

  it('first approve: source files present, no log entry → refused (bootstrap mandatory)', async () => {
    const { projectRoot, nodePath } = await setup({});
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(refuseMsg(result)).toMatch(/mandatory.*entry|no log entry/i);
  });

  it('first approve: log entry present → initial', async () => {
    const log = '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n';
    const { projectRoot, nodePath } = await setup({ initialLogContent: log });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('initial');
    expect(result.pendingDriftState?.state.log?.last_entry_datetime).toBe('2026-05-11T10:00:00.000Z');
  });

  it('first approve: log_required: false, no log entry → initial', async () => {
    const { projectRoot, nodePath } = await setup({ logRequiredOnModule: false });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('initial');
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
    // Source files match current (no source drift), but the typed identity is
    // stale (ownSubset hash wrong) → upstream drift only. Hash 'h' won't match
    // the fresh canonical hash, so approve proceeds.
    await writeNodeDriftState(yggRoot, nodePath, {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      hash: 'h',
      files: {
        'src/svc.ts': srcHash,
        '.yggdrasil/aspects/a1/content.md': sha('rule.\n'),
      },
      identity: { ownSubset: 'h-stale-own', ports: {}, aspects: {} },
      aspectVerdicts: {},
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
    expect(refuseMsg(result)).toMatch(/integrity|boundary_missing/i);
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
    expect(refuseMsg(result)).toMatch(/symlink/i);
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
    expect(refuseMsg(result)).toMatch(/hard link/i);
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
    expect(refuseMsg(result)).toMatch(/format/i);
    expect(refuseMsg(result)).toMatch(/Post-baseline/i);
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
    expect(refuseMsg(result)).toMatch(/format/i);
    expect(refuseMsg(result)).toMatch(/Pre-baseline/i);
  });

  it('re-blocks a source change on a node first approved WITHOUT a log baseline (closed baseline hole)', async () => {
    // A baseline exists (files map populated) but carries NO log baseline — e.g.
    // the node was first approved while log_required was off, or before any entry
    // existed. When source later changes under a log_required type, the mandatory
    // entry gate must still fire. The fix drops the `storedEntry?.log` condition
    // from the mandatory check so this hole is closed.
    const { projectRoot, nodePath, sourcePath } = await setup({
      // No initialLogContent → no log.md, no entries.
      initialSourceHash: 'h-old',
      // initialBaseline omitted → drift state written with files map but log: undefined.
    });
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(refuseMsg(result)).toMatch(/no log entry|mandatory/i);
  });

  it('re-blocks a source change when a baseline (no log) exists and only a stale entry is present', async () => {
    // Baseline without a log boundary, but a log.md entry exists. Because there is
    // no recorded last_entry_datetime, "fresh" means "any entry" — and an entry IS
    // present, so the gate is satisfied and the change is approved.
    const log = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot, nodePath, sourcePath } = await setup({
      initialLogContent: log,
      initialSourceHash: 'h-old',
      // initialBaseline omitted → log: undefined in drift state.
    });
    await writeFile(sourcePath, 'export const x = 2;\n');
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('approved');
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
    logRequired?: boolean;
  }): Promise<{ projectRoot: string; nodePath: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-logical-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    const nodeDir = path.join(yggRoot, 'model', 'mod');
    await mkdir(nodeDir, { recursive: true });
    await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');
    const archModule = opts.logRequired === undefined
      ? '    description: m\n'
      : `    description: m\n    log_required: ${opts.logRequired}\n`;
    await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), `node_types:\n  module:\n${archModule}`);
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

  it('rejects no-mapping node without log.md when log_required is true (default)', async () => {
    const { projectRoot, nodePath } = await setupLogical({});
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).toBe('refused');
    expect(refuseMsg(result)).toMatch(/no mapping|no log/i);
  });

  it('does NOT demand a log on a no-mapping node whose type has log_required: false', async () => {
    // Bug (b): the no-mapping path previously refused unconditionally when no
    // log.md existed. It must honor the node type's log_required flag — when
    // false, a mapping-less node with no log is a clean no-op (nothing to track).
    const { projectRoot, nodePath } = await setupLogical({ logRequired: false });
    const graph = await loadGraph(projectRoot);
    const result = await approveNode(graph, nodePath);
    expect(result.action).not.toBe('refused');
    expect(result.refuseReasonData).toBeUndefined();
  });
});
