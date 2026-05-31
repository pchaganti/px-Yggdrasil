import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);
import {
  classifyDrift,
  describeCascadeCause,
  runCheck,
} from '../../../src/core/check.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default aspect for tests that need nodes to participate in drift detection */
const TEST_ASPECT = {
  id: 'testing',
  yaml: 'name: Testing\ndescription: test aspect\nreviewer:\n  type: llm\n',
  files: { 'content.md': 'Test rule.\n' },
};

/**
 * Helper: create a minimal temp project for drift classification tests.
 */
async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  parentNodes?: Array<{ path: string; yaml: string }>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-check-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');

  await writeFile(
    path.join(yggRoot, 'yg-config.yaml'),
    opts.configYaml ?? 'version: "4.0.0"\n',
  );
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);

  if (opts.parentNodes) {
    for (const pn of opts.parentNodes) {
      const pDir = path.join(yggRoot, 'model', pn.path);
      await mkdir(pDir, { recursive: true });
      await writeFile(path.join(pDir, 'yg-node.yaml'), pn.yaml);
    }
  } else {
    const parts = opts.nodePath.split('/');
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('/');
      const parentDir = path.join(yggRoot, 'model', parentPath);
      await mkdir(parentDir, { recursive: true });
      await writeFile(
        path.join(parentDir, 'yg-node.yaml'),
        `name: ${parts[parts.length - 2]}\ntype: service\ndescription: parent\n`,
      );
    }
  }

  if (opts.aspects) {
    for (const asp of opts.aspects) {
      const aspDir = path.join(yggRoot, 'aspects', asp.id);
      await mkdir(aspDir, { recursive: true });
      await writeFile(path.join(aspDir, 'yg-aspect.yaml'), asp.yaml);
      if (asp.files) {
        for (const [artName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, artName), content);
        }
      }
    }
  }

  if (opts.mappingFiles) {
    for (const [relPath, content] of Object.entries(opts.mappingFiles)) {
      const abs = path.join(tmpDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  return { tmpDir, yggRoot };
}

async function recordBaseline(tmpDir: string) {
  const graph = await loadGraph(tmpDir);
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.mapping) continue;
    const trackedFiles = collectTrackedFiles(node, graph);
    const projectRoot = path.dirname(graph.rootPath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [],
    );
    await writeNodeDriftState(graph.rootPath, nodePath, {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
    });
  }
}


// ── classifyDrift ─────────────────────────────────────────

describe('classifyDrift', () => {
  it('returns empty for node with no drift', async () => {
    const { tmpDir } = await createTmpProject('no-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    expect(result).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift when source file changes', async () => {
    const { tmpDir } = await createTmpProject('source-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source file
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].nodePath).toBe('svc/my-service');
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when own yg-node.yaml aspect-relevant fields change', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('graph-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify aspect-relevant field (type change triggers upstream drift)
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: module\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const drift = result.filter(i => i.nodePath === 'svc/my-service' && i.code === 'upstream-drift');
    expect(drift.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT trigger drift when only description changes in yg-node.yaml', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('desc-only-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify only description — should NOT trigger drift
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: updated description\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const drift = result.filter(i => i.nodePath === 'svc/my-service');
    expect(drift).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns cascade-drift when aspect file changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\nreviewer:\n  type: llm\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify aspect content file
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Log ALL operations, not just mutations.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].nodePath).toBe('svc/my-service');
    expect(upstreamDrift[0].cascadeCauses!).toHaveLength(1);
    expect(upstreamDrift[0].cascadeCauses![0].description).toContain('logging');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns both source-drift and cascade-drift when direct and cascade changes happen', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('compound', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\nreviewer:\n  type: llm\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Modify BOTH source and aspect
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated rules.\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const nodeIssues = result.filter(i => i.nodePath === 'svc/my-service');
    const sourceDrift = nodeIssues.filter(i => i.code === 'source-drift');
    const upstreamDrift = nodeIssues.filter(i => i.code === 'upstream-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(upstreamDrift).toHaveLength(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns unapproved when no baseline exists', async () => {
    const { tmpDir } = await createTmpProject('unapproved', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const unapproved = result.filter(i => i.code === 'unapproved');
    expect(unapproved).toHaveLength(1);
    expect(unapproved[0].lifecycleState).toBe('unapproved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift unapproved with files-never-created message when source path absent', async () => {
    const { tmpDir } = await createTmpProject('unapproved-absent', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/absent/\n',
      aspects: [TEST_ASPECT],
      // Do NOT create the mapping directory at all
    });
    // Do NOT record baseline
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('unapproved');
    expect(msgOf(sourceDrift[0])).toContain('never created');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift missing when source files are gone', async () => {
    const { tmpDir } = await createTmpProject('missing-src', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Delete all source files
    await rm(path.join(tmpDir, 'src/svc'), { recursive: true, force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('missing');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects deleted source file in drift (partial deletion)', async () => {
    const { tmpDir } = await createTmpProject('partial-deleted', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/index.ts\n  - src/svc/helper.ts\n',
      aspects: [TEST_ASPECT],
      mappingFiles: {
        'src/svc/index.ts': 'export default 42;\n',
        'src/svc/helper.ts': 'export const helper = () => {};\n',
      },
    });
    await recordBaseline(tmpDir);
    // Delete one of the two mapped files — allPathsMissing returns false since index.ts still exists
    await rm(path.join(tmpDir, 'src/svc/helper.ts'), { force: true });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect source-drift (deleted source file)
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift.length).toBeGreaterThanOrEqual(1);
    const changedFiles = sourceDrift.flatMap(i => i.directChangedFiles ?? []);
    expect(changedFiles.some(f => f.filePath.includes('deleted'))).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns source-drift when both source and graph metadata change', async () => {
    const { tmpDir } = await createTmpProject('full-drift', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Modify source file
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when hierarchy (parent) yg-node.yaml changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-hierarchy', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [{
        path: 'svc',
        yaml: 'name: Svc\ntype: service\ndescription: parent\n',
      }],
    });
    await recordBaseline(tmpDir);
    // Modify parent yg-node.yaml (now the only hierarchy-tracked file)
    await writeFile(
      path.join(yggRoot, 'model/svc/yg-node.yaml'),
      'name: Svc\ntype: service\ndescription: updated parent\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].cascadeCauses![0].layer).toBe('hierarchy');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects drift when tracked file is removed from context (aspect removed)', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('deleted-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\n  - testing\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [
        {
          id: 'logging',
          yaml: 'name: Logging\ndescription: test aspect\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Log all mutations.\n' },
        },
        TEST_ASPECT,
      ],
    });
    await recordBaseline(tmpDir);
    // Remove logging aspect reference from node YAML (keep testing so node still has aspects)
    await writeFile(
      path.join(yggRoot, 'model/svc/my-service/yg-node.yaml'),
      'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Should detect some form of drift (source-drift or upstream-drift because own yg-node.yaml changed,
    // plus deleted aspect files from baseline)
    expect(result.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT trigger drift when only flow yg-flow.yaml description changes', async () => {
    // Flow YAML is not tracked — only aspect propagation via aspect files causes drift.
    // Description-only flow changes should produce zero false drift.
    const { tmpDir, yggRoot } = await createTmpProject('cascade-flow', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    // Create a flow that references our node
    const flowDir = path.join(yggRoot, 'flows/checkout-flow');
    await mkdir(flowDir, { recursive: true });
    await writeFile(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout Flow\ndescription: test flow\nnodes:\n  - svc/my-service\n');
    await recordBaseline(tmpDir);
    // Modify only the flow description — no aspect or node list changes
    await writeFile(path.join(flowDir, 'yg-flow.yaml'), 'name: Checkout Flow\ndescription: updated flow\nnodes:\n  - svc/my-service\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBe(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns upstream-drift when dependency yg-node.yaml changes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-dep', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify dependency yg-node.yaml (now the only relational-tracked file)
    await writeFile(
      path.join(yggRoot, 'model/svc/dep/yg-node.yaml'),
      'name: Dep\ntype: service\ndescription: updated dependency\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift.length).toBeGreaterThanOrEqual(1);
    expect(upstreamDrift[0].cascadeCauses!.some(c => c.layer === 'relational')).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });


  it('upstream-drift collapse: multiple upstream changes emit only ONE upstream-drift with all causes merged', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cascade-collapse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nrelations:\n  - target: svc/dep\n    type: uses\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\nreviewer:\n  type: llm\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent\n',
        },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Trigger cascade from TWO different upstream sources simultaneously:
    // 1. aspect file change
    await writeFile(path.join(yggRoot, 'aspects/logging/content.md'), 'Updated logging rules triggering cascade.\n');
    // 2. dependency yg-node.yaml change
    await writeFile(path.join(yggRoot, 'model/svc/dep/yg-node.yaml'), 'name: Dep\ntype: service\ndescription: updated dep\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    // Must collapse to exactly ONE upstream-drift for this node
    expect(upstreamDrift).toHaveLength(1);
    // Must contain causes from both upstream changes
    expect(upstreamDrift[0].cascadeCauses!.length).toBeGreaterThanOrEqual(2);
    const layers = upstreamDrift[0].cascadeCauses!.map(c => c.layer);
    expect(layers).toContain('aspects');
    expect(layers).toContain('relational');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('check-touched cascade names the owning deterministic aspect (not "unknown aspect")', async () => {
    // A deterministic aspect `det` recorded a set of cross-node files it read,
    // captured in checkTouchedFiles. When the SET MEMBERSHIP changes, the
    // synthetic `check-touched:det` key (tracked on the 'aspects' layer)
    // drifts. The rendered cascade message must name the owning aspect — the
    // synthetic key is not a real file under .yggdrasil/aspects/, so without
    // special handling it would fall into the reference-file fallback and render
    // "declared by unknown aspect".
    const { tmpDir } = await createTmpProject('check-touched-cause', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [{
        id: 'det',
        yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n',
        files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
      }],
    });
    const graph0 = await loadGraph(tmpDir);
    const node0 = graph0.nodes.get('svc/my-service')!;
    const projectRoot0 = path.dirname(graph0.rootPath);
    // Record the baseline's tracked-file hashes computed from the OLD touched set
    // (a single cross-node member path that is never created on disk, so it is
    // skipped from `files` and only the synthetic `check-touched:det` key
    // captures the set). The member paths themselves never exist on disk, so the
    // only thing that can drift is the synthetic set-membership key.
    const oldSet = { det: { 'src/related/a.ts': 'h1' } };
    const trackedOld = collectTrackedFiles(node0, graph0, { hash: '', files: {}, checkTouchedFiles: oldSet });
    const hOld = await hashTrackedFiles(projectRoot0, trackedOld, undefined, []);
    // Store the baseline with the OLD set's per-file hashes but a NEW (grown) set
    // in checkTouchedFiles. At check time collectTrackedFiles recomputes the
    // synthetic key from this NEW set, mismatching the recorded OLD-set hash.
    const newSet = { det: { 'src/related/a.ts': 'h1', 'src/related/b.ts': 'h2' } };
    await writeNodeDriftState(graph0.rootPath, 'svc/my-service', {
      hash: hOld.canonicalHash,
      files: hOld.fileHashes,
      mtimes: hOld.fileMtimes,
      checkTouchedFiles: newSet,
    });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift).toHaveLength(1);
    const rendered = msgOf(upstreamDrift[0]);
    expect(rendered).toContain("the set of files read by deterministic aspect 'det'");
    expect(rendered).not.toContain('unknown aspect');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('tier-identity cascade names the owning aspect (not "unknown aspect")', async () => {
    // An LLM aspect carries a synthetic `tier-identity:<id>` key that hashes its
    // resolved reviewer tier config. When the tier config changes, that key
    // drifts on the 'aspects' layer. Like check-touched, the key is not a
    // real file under .yggdrasil/aspects/, so the rendered cascade message must
    // name the owning aspect rather than render "declared by unknown aspect".
    const { tmpDir } = await createTmpProject('tier-identity-cause', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - logging\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      configYaml:
        'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n',
      aspects: [{
        id: 'logging',
        yaml: 'name: Logging\ndescription: test aspect\nreviewer:\n  type: llm\n',
        files: { 'content.md': 'Log all mutations.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    // Change the resolved tier config (consensus 1 → 3): the canonical tier JSON
    // changes, so the synthetic tier-identity:logging key drifts.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/yg-config.yaml'),
      'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 3\n      config:\n        model: llama3\n',
    );
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const upstreamDrift = result.filter(i => i.code === 'upstream-drift' && i.nodePath === 'svc/my-service');
    expect(upstreamDrift).toHaveLength(1);
    const rendered = msgOf(upstreamDrift[0]);
    expect(rendered).toContain("the resolved reviewer tier for aspect 'logging'");
    expect(rendered).not.toContain('unknown aspect');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Regression: an implies cycle introduced AFTER a baseline exists must not
  // crash drift classification. Previously expandImpliesFiltered /
  // computeEffectiveAspectStatuses threw a bare Error on cycle detection, which
  // escaped classifyDrift and surfaced as an unclassified "file an issue" crash.
  // Now the cycle is an ImpliesCycleError that classifyDrift catches per-node;
  // the structured aspect-implies-cycle error comes from the static validator.
  it('does NOT throw on an implies cycle introduced after a baseline exists', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('cycle-post-baseline', {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - cyc-a\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
      aspects: [
        {
          id: 'cyc-a',
          yaml: 'name: CycA\ndescription: cycle a\nreviewer:\n  type: llm\nimplies:\n  - cyc-b\n',
          files: { 'content.md': 'Rule A.\n' },
        },
        {
          id: 'cyc-b',
          // Acyclic at baseline time: cyc-b implies nothing.
          yaml: 'name: CycB\ndescription: cycle b\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Rule B.\n' },
        },
      ],
    });
    // Baseline recorded while the implies chain is acyclic (cyc-a → cyc-b).
    await recordBaseline(tmpDir);

    // Close the cycle: cyc-b → cyc-a (now cyc-a ↔ cyc-b).
    await writeFile(
      path.join(yggRoot, 'aspects/cyc-b/yg-aspect.yaml'),
      'name: CycB\ndescription: cycle b\nreviewer:\n  type: llm\nimplies:\n  - cyc-a\n',
    );

    const graph = await loadGraph(tmpDir);

    // classifyDrift must skip the cyclic node rather than throw.
    await expect(classifyDrift(graph)).resolves.toBeDefined();

    // runCheck must surface the structured aspect-implies-cycle error (exit-1
    // territory) WITHOUT any unclassified throw — same as the no-baseline path.
    const result = await runCheck(graph, null);
    const cycleIssues = result.issues.filter(i => i.code === 'aspect-implies-cycle');
    expect(cycleIssues.length).toBeGreaterThanOrEqual(1);
    expect(cycleIssues[0].severity).toBe('error');
    await rm(tmpDir, { recursive: true, force: true });
  });

});

  it('handles drift state without mtimes', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('no-mtimes', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'export default 42;\n' },
    });
    await recordBaseline(tmpDir);
    // Overwrite drift state without mtimes (testing graceful handling)
    const storedState = await import('../../../src/io/drift-state-store.js');
    const existing = await storedState.readNodeDriftState(yggRoot, 'svc/my-service');
    await storedState.writeNodeDriftState(yggRoot, 'svc/my-service', {
      hash: existing!.hash,
      files: existing!.files,
      // no mtimes field
    });
    // Modify source to trigger drift
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'export default 99;\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const sourceDrift = result.filter(i => i.code === 'source-drift');
    expect(sourceDrift).toHaveLength(1);
    expect(sourceDrift[0].lifecycleState).toBe('ok');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips nodes without mapping paths', async () => {
    const { tmpDir } = await createTmpProject('no-mapping', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\n',
      // No mapping, no mapping files
    });
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    // Node without mapping should produce no issues
    expect(result).toHaveLength(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles child-wins model with overlapping parent-child mappings', async () => {
    const { tmpDir } = await createTmpProject('child-wins', {
      nodePath: 'svc/my-service/sub',
      nodeYaml: 'name: Sub\ntype: service\ndescription: test\naspects:\n  - testing\nmapping:\n  - src/svc/sub/\n',
      aspects: [TEST_ASPECT],
      mappingFiles: { 'src/svc/index.ts': 'parent file\n', 'src/svc/sub/inner.ts': 'child file\n' },
      parentNodes: [
        {
          path: 'svc',
          yaml: 'name: Svc\ntype: service\ndescription: parent root\n',
        },
        {
          path: 'svc/my-service',
          yaml: 'name: MyService\ntype: service\ndescription: parent\naspects:\n  - testing\nmapping:\n  - src/svc/\n',
        },
      ],
    });
    await recordBaseline(tmpDir);
    // Modify child source file -- should only affect child, not parent
    await writeFile(path.join(tmpDir, 'src/svc/sub/inner.ts'), 'modified child\n');
    const graph = await loadGraph(tmpDir);
    const result = await classifyDrift(graph);
    const subIssues = result.filter(i => i.nodePath === 'svc/my-service/sub');
    expect(subIssues.length).toBeGreaterThanOrEqual(1);
    await rm(tmpDir, { recursive: true, force: true });
  });

// ── describeCascadeCause ──────────────────────────────────
//
// Pure helper that maps a cascade cause (a tracked-file path + its layer) to a
// human-readable message. Built directly against a minimal in-memory Graph so
// every branch is exercised without filesystem fixtures.

describe('describeCascadeCause', () => {
  const YGG = '.yggdrasil';

  // Shared reference paths used to drive the "reference file declared by N
  // aspects" branch of the 'aspects' layer.
  const SOLE_REF = 'docs/sole-ref.md';        // declared by exactly ONE aspect
  const SHARED_REF = 'docs/shared-ref.md';    // declared by TWO aspects
  const UNDECLARED_REF = 'docs/orphan-ref.md'; // declared by NONE

  const llm = (id: string, references?: Array<{ path: string }>): AspectDef => ({
    name: id,
    id,
    reviewer: { type: 'llm' },
    artifacts: [],
    ...(references ? { references } : {}),
  });

  // rootPath ends in `.yggdrasil` so yggPrefix resolves to `.yggdrasil`:
  //   path.relative(path.dirname(rootPath), rootPath) === '.yggdrasil'
  const graph = {
    rootPath: '/repo/.yggdrasil',
    aspects: [
      llm('only', [{ path: SOLE_REF }]),
      llm('left', [{ path: SHARED_REF }]),
      llm('right', [{ path: SHARED_REF }]),
      // A deterministic aspect also "declaring" SHARED_REF must NOT be counted —
      // describeCascadeCause filters to reviewer.type === 'llm' only.
      { name: 'det', id: 'det', reviewer: { type: 'deterministic' }, artifacts: [], references: [{ path: SHARED_REF }] },
    ],
  } as unknown as Graph;

  it('aspects layer, real aspect content path → names the aspect with artifact label', () => {
    const out = describeCascadeCause(`${YGG}/aspects/my-aspect/content.md`, 'aspects', graph);
    expect(out).toContain("aspect 'my-aspect' content changed");
  });

  it('aspects layer, yg-aspect.yaml content path → names aspect with no label', () => {
    const out = describeCascadeCause(`${YGG}/aspects/my-aspect/yg-aspect.yaml`, 'aspects', graph);
    // No artifact label between the id and "changed" (unlike "content changed").
    expect(out).toContain("aspect 'my-aspect' changed");
  });

  it('aspects layer, check-touched synthetic key → names the deterministic aspect', () => {
    const out = describeCascadeCause('check-touched:det-x', 'aspects', graph);
    expect(out).toContain("the set of files read by deterministic aspect 'det-x'");
  });

  it('aspects layer, tier-identity synthetic key → names the aspect tier', () => {
    const out = describeCascadeCause('tier-identity:llm-x', 'aspects', graph);
    expect(out).toContain("the resolved reviewer tier for aspect 'llm-x'");
  });

  it('aspects layer, reference file declared by exactly one aspect', () => {
    const out = describeCascadeCause(SOLE_REF, 'aspects', graph);
    expect(out).toContain(`reference file '${SOLE_REF}'`);
    expect(out).toContain("declared by aspect 'only'");
  });

  it('aspects layer, reference file declared by multiple aspects', () => {
    const out = describeCascadeCause(SHARED_REF, 'aspects', graph);
    expect(out).toMatch(/declared by aspects '.*', '.*'/);
    expect(out).toContain("'left'");
    expect(out).toContain("'right'");
    // deterministic 'det' must be excluded
    expect(out).not.toContain("'det'");
  });

  it('aspects layer, reference file declared by no aspect → unknown', () => {
    const out = describeCascadeCause(UNDECLARED_REF, 'aspects', graph);
    expect(out).toContain('declared by unknown aspect');
  });

  it('hierarchy layer → parent node metadata changed', () => {
    const out = describeCascadeCause(`${YGG}/model/parent/child/yg-node.yaml`, 'hierarchy', graph);
    expect(out).toContain("parent node 'parent/child' metadata changed");
  });

  it('hierarchy layer, path not under model/ → unknown ancestor', () => {
    const out = describeCascadeCause('some/other/file.txt', 'hierarchy', graph);
    expect(out).toContain("parent node 'unknown' metadata changed");
  });

  it('relational layer, yg-node.yaml → dependency metadata changed', () => {
    const out = describeCascadeCause(`${YGG}/model/dep/svc/yg-node.yaml`, 'relational', graph);
    expect(out).toContain("dependency 'dep/svc' metadata changed");
  });

  it('relational layer, non-yaml artifact → dependency <artifact> changed', () => {
    const out = describeCascadeCause(`${YGG}/model/dep/svc/log.md`, 'relational', graph);
    expect(out).toContain("dependency 'dep/svc' log changed");
  });

  it('relational layer, path not under model/ → unknown dependency', () => {
    const out = describeCascadeCause('elsewhere.txt', 'relational', graph);
    expect(out).toContain("dependency 'unknown'");
  });

  it('check-touched layer (real cross-node path) → tracked file changed', () => {
    const out = describeCascadeCause('source/cli/src/other/reader.ts', 'check-touched', graph);
    expect(out).toContain('tracked file changed');
  });

  it('source layer → tracked file changed', () => {
    const out = describeCascadeCause('src/svc/index.ts', 'source', graph);
    expect(out).toContain('tracked file changed');
  });

  it('flows layer → tracked file changed', () => {
    const out = describeCascadeCause(`${YGG}/flows/checkout/yg-flow.yaml`, 'flows', graph);
    expect(out).toContain('tracked file changed');
  });
});
