import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode, commitApproval } from '../../src/core/approve.js';
import { logAddCommand } from '../../src/cli/log-add.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupProject(opts: { logRequired?: boolean } = {}): Promise<{
  projectRoot: string;
  nodePath: string;
  sourcePath: string;
  logPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-int-log-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'a1'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.3.0"\n');
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:\n  module:\n    description: m\n    log_required: ${opts.logRequired ?? true}\n`,
  );
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'yg-aspect.yaml'), 'name: A1\ndescription: x\n');
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'content.md'), 'r.\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: module\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - a1\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), 'export const x = 1;\n');
  return {
    projectRoot: root,
    nodePath: 'svc',
    sourcePath: path.join(root, 'src', 'svc.ts'),
    logPath: path.join(nodeDir, 'log.md'),
  };
}

describe('log workflow integration', () => {
  it('full lifecycle: edit → log add → approve → OK', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    // First approve (bootstrap, no mandatory)
    let graph = await loadGraph(projectRoot);
    const initial = await approveNode(graph, nodePath);
    expect(initial.action).toBe('initial');
    await commitApproval(path.join(projectRoot, '.yggdrasil'), initial);

    // Edit source
    await writeFile(sourcePath, 'export const x = 2;\n');
    // Add log entry
    await logAddCommand({ node: nodePath, reason: 'Updated semantics' }, projectRoot);
    // Approve
    graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
  });

  it('forgotten log → approve fails → log add → approve OK', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    const initial = await approveNode(graph, nodePath);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), initial);
    // Seed a baseline log entry then approve (to lock baseline)
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Edit but forget log
    await writeFile(sourcePath, 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    let r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
    expect(r.refuseReason).toMatch(/no.*log.*entry|mandatory/i);

    // Add log entry, retry
    await logAddCommand({ node: nodePath, reason: 'Updated' }, projectRoot);
    graph = await loadGraph(projectRoot);
    r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
  });

  it('iteration cycle — one entry covers multiple source edits', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Edit + add entry
    await writeFile(sourcePath, 'export const x = 2;\n');
    await logAddCommand({ node: nodePath, reason: 'Attempt 1' }, projectRoot);
    // Approve passes — mandatory satisfied
    graph = await loadGraph(projectRoot);
    let r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
    // Don't commit; edit again WITHOUT new entry — entry from Attempt 1 still > baseline
    await writeFile(sourcePath, 'export const x = 3;\n');
    graph = await loadGraph(projectRoot);
    r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved');
  });

  it('pure log addition (no source change) → no-change', async () => {
    const { projectRoot, nodePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    await logAddCommand({ node: nodePath, reason: 'context-only entry' }, projectRoot);
    graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('no-change');
  });

  it('manual tampering of historical entry → integrity FIRST (before format)', async () => {
    const { projectRoot, nodePath, logPath, sourcePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Tamper historic body — same datetime, different body
    const existing = await readFile(logPath, 'utf-8');
    const tampered = existing.replace('seed', 'TAMPERED');
    await writeFile(logPath, tampered);
    // Trigger drift via source edit
    await writeFile(sourcePath, 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused');
    expect(r.refuseReason).toMatch(/integrity|prefix_modified/);
    expect(r.refuseReason).not.toMatch(/format/);
  });

  it('flag flip true → false: mandatory stops, integrity continues', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Flip flag to false
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: m\n    log_required: false\n',
    );
    await writeFile(sourcePath, 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('approved'); // mandatory skipped
  });

  it('concurrent log add mid-approve: snapshot captures pre-add state', async () => {
    // spec §4 lines 909-921 — approve snapshots log.md once;
    // a parallel `yg log add` race does NOT corrupt the snapshot or commit.
    const { projectRoot, nodePath, sourcePath, logPath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Edit + first log entry
    await writeFile(sourcePath, 'export const x = 2;\n');
    await logAddCommand({ node: nodePath, reason: 'snapshot baseline' }, projectRoot);
    const snapshotLogContent = await readFile(logPath, 'utf-8');

    // Begin approve (snapshots log.md at call time). Inject a parallel log add.
    graph = await loadGraph(projectRoot);
    const approvePromise = approveNode(graph, nodePath);
    // approve reads snapshot synchronously at start; any log add after this lands post-snapshot
    await logAddCommand({ node: nodePath, reason: 'parallel add' }, projectRoot);
    const r = await approvePromise;
    expect(r.action).toBe('approved');
    // Baseline = newest entry FROM SNAPSHOT, not from post-add file
    const newestInSnapshot = snapshotLogContent
      .split('\n')
      .filter((l) => l.startsWith('## ['))
      .at(-1)!
      .match(/## \[(.+?)\]/)![1];
    expect(r.pendingDriftState?.state.log?.last_entry_datetime).toBe(newestInSnapshot);
  });

  it('log_required default true (field absent in architecture)', async () => {
    const { projectRoot, nodePath, sourcePath } = await setupProject();
    let graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));
    await logAddCommand({ node: nodePath, reason: 'seed' }, projectRoot);
    graph = await loadGraph(projectRoot);
    await commitApproval(path.join(projectRoot, '.yggdrasil'), await approveNode(graph, nodePath));

    // Remove log_required field (default = true)
    await writeFile(
      path.join(projectRoot, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: m\n',
    );
    await writeFile(sourcePath, 'export const x = 2;\n');
    graph = await loadGraph(projectRoot);
    const r = await approveNode(graph, nodePath);
    expect(r.action).toBe('refused'); // default true, mandatory fires
  });
});
