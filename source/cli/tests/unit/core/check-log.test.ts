import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { classifyDrift, runCheck } from '../../../src/core/check.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');

async function setup(opts: {
  log?: string;
  baseline?: { last_entry_datetime: string; prefix_hash: string };
  mapped?: boolean;
}): Promise<{ projectRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-checklog-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'a1'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.2.0"\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  module:\n    description: m\n');
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'yg-aspect.yaml'), 'name: A1\ndescription: x\n');
  await writeFile(path.join(yggRoot, 'aspects', 'a1', 'content.md'), 'r.\n');
  const yaml = (opts.mapped ?? true)
    ? 'name: svc\ntype: module\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - a1\n'
    : 'name: svc\ntype: module\ndescription: x\naspects:\n  - a1\n';
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), yaml);
  await writeFile(path.join(root, 'src', 'svc.ts'), 'x\n');
  if (opts.log !== undefined) await writeFile(path.join(nodeDir, 'log.md'), opts.log);
  if (opts.baseline !== undefined) {
    await writeNodeDriftState(yggRoot, 'svc', {
      hash: 'h',
      files: {
        'src/svc.ts': sha('x\n'),
        '.yggdrasil/aspects/a1/content.md': sha('r.\n'),
        '.yggdrasil/model/svc/yg-node.yaml': sha(yaml),
      },
      log: opts.baseline,
    });
  }
  return { projectRoot: root };
}

describe('classifyDrift — log issues', () => {
  it('emits log-integrity issue on prefix mismatch', async () => {
    const orig = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const tamp = '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n';
    const { projectRoot } = await setup({
      log: tamp,
      baseline: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(orig) },
    });
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    expect(issues.find((i) => i.code === 'log-integrity')).toBeDefined();
  });

  it('emits log-format issue on malformed log', async () => {
    const bad = '## [2026-05-11T10:00:00.000Z]\nintro.\n## stray.\n';
    const { projectRoot } = await setup({
      log: bad,
      baseline: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(bad) },
    });
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    expect(issues.find((i) => i.code === 'log-format')).toBeDefined();
  });

  it('no log issue when log absent or valid (no file)', async () => {
    const { projectRoot } = await setup({});
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    expect(issues.find((i) => i.code === 'log-integrity')).toBeUndefined();
    expect(issues.find((i) => i.code === 'log-format')).toBeUndefined();
  });

  it('no log issue when log exists and is valid (format ok, no baseline)', async () => {
    const good = '## [2026-05-11T10:00:00.000Z]\nAll fine.\n';
    const { projectRoot } = await setup({ log: good });
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    expect(issues.find((i) => i.code === 'log-integrity')).toBeUndefined();
    expect(issues.find((i) => i.code === 'log-format')).toBeUndefined();
  });

  it('logical node (no mapping) with malformed log → log-format issue', async () => {
    const bad = '## [2026-05-11T10:00:00.000Z]\nintro.\n## stray.\n';
    const { projectRoot } = await setup({ mapped: false, log: bad });
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    expect(issues.find((i) => i.code === 'log-format')).toBeDefined();
  });

  it('emits log-integrity issue when log.md missing but baseline exists (boundary_missing)', async () => {
    const orig = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const { projectRoot } = await setup({
      // No log: undefined → log.md will not be written
      baseline: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(orig) },
    });
    const graph = await loadGraph(projectRoot);
    const issues = await classifyDrift(graph);
    const integrityIssue = issues.find((i) => i.code === 'log-integrity');
    expect(integrityIssue).toBeDefined();
    expect(integrityIssue?.message).toMatch(/boundary_missing|file missing/i);
  });
});

describe('runCheck — suggestedNext for log codes', () => {
  it('suggests git checkout when log-integrity error present', async () => {
    const orig = '## [2026-05-11T10:00:00.000Z]\nfirst.\n';
    const tamp = '## [2026-05-11T10:00:00.000Z]\nTAMPERED.\n';
    const { projectRoot } = await setup({
      log: tamp,
      baseline: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(orig) },
    });
    const graph = await loadGraph(projectRoot);
    const result = await runCheck(graph, []);
    expect(result.suggestedNext).toMatch(/git checkout/);
    expect(result.suggestedNext).toMatch(/log\.md/);
  });

  it('suggests manual edit when log-format error present (no integrity error, no drift)', async () => {
    const bad = '## [2026-05-11T10:00:00.000Z]\nintro.\n## stray.\n';
    const { projectRoot } = await setup({
      log: bad,
      baseline: { last_entry_datetime: '2026-05-11T10:00:00.000Z', prefix_hash: sha(bad) },
    });
    const graph = await loadGraph(projectRoot);
    const result = await runCheck(graph, []);
    expect(result.suggestedNext).toMatch(/Edit.*log\.md.*format|fix format/i);
  });
});
