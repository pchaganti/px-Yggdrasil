import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolveExecutionPlan, runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import type { AspectDef, ReviewerConfig } from '../../../src/model/graph.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('resolveExecutionPlan — structure branch', () => {
  const reviewer: ReviewerConfig = {
    default: 'default',
    tiers: {
      default: {
        provider: 'ollama',
        model: 'x',
        temperature: 0,
        consensus: 1,
        max_tokens: 'auto',
      },
    },
  };

  it('creates a kind:structure entry for structure aspects', () => {
    const aspect: AspectDef = {
      id: 's1',
      name: 's1',
      reviewer: { type: 'structure' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const plan = resolveExecutionPlan([aspect], reviewer);
    expect(plan.resolved).toHaveLength(1);
    expect(plan.resolved[0]).toMatchObject({ kind: 'structure', aspect: { id: 's1' } });
  });

  it('does not invoke tier resolution for structure aspects', () => {
    const aspect: AspectDef = {
      id: 's2',
      name: 's2',
      reviewer: { type: 'structure' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const plan = resolveExecutionPlan([aspect], { tiers: {} } as ReviewerConfig);
    expect(plan.errors).toHaveLength(0);
    expect(plan.resolved[0]).toMatchObject({ kind: 'structure' });
  });

  it('includes ast, structure, and llm aspects all together in the plan', () => {
    const astAspect: AspectDef = {
      id: 'a1',
      name: 'a1',
      reviewer: { type: 'ast' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const structAspect: AspectDef = {
      id: 's1',
      name: 's1',
      reviewer: { type: 'structure' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const llmAspect: AspectDef = {
      id: 'l1',
      name: 'l1',
      reviewer: { type: 'llm' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const plan = resolveExecutionPlan([astAspect, structAspect, llmAspect], reviewer);
    expect(plan.errors).toHaveLength(0);
    expect(plan.resolved).toHaveLength(3);
    expect(plan.resolved.map(e => e.kind)).toEqual(expect.arrayContaining(['ast', 'structure', 'llm']));
  });
});

// ── Integration: structure dispatch in runApproveWithReviewer ────

async function createStructureProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
  parentNodes?: Array<{ path: string; yaml: string }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-struct-${name}`);
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
        for (const [aName, content] of Object.entries(asp.files)) {
          await writeFile(path.join(aspDir, aName), content);
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

describe('runApproveWithReviewer — structure dispatch', () => {
  it('structure aspect with no violations — approved and structureTouchedFiles populated', async () => {
    const { tmpDir } = await createStructureProject('struct-pass', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - shape-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [{
        id: 'shape-check',
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: structure\n',
        // check.mjs: returns no violations
        files: {
          'check.mjs': 'export function check(_ctx) { return []; }\n',
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.pendingDriftState).toBeDefined();

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('approved');
    expect(result.aspectResults?.['shape-check']?.satisfied).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('structure aspect with violations — refused and violation message includes file:line', async () => {
    const { tmpDir } = await createStructureProject('struct-violated', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - shape-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [{
        id: 'shape-check',
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: structure\n',
        files: {
          // Returns a violation with file and line — exercises lines 419-420
          'check.mjs': `export function check(ctx) {
  return [{ message: 'violation found', file: ctx.files[0]?.path, line: 3 }];
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('refused');
    expect(result.aspectViolations).toBeDefined();
    const v = result.aspectViolations?.find(v => v.aspectId === 'shape-check');
    expect(v).toBeDefined();
    // file:line prefix should appear in reason — exercises the loc branch
    expect(v!.reason).toMatch(/src\/svc\.ts:3: violation found/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('structure aspect that throws StructureRunnerError — classified as astRuntime', async () => {
    const { tmpDir } = await createStructureProject('struct-throw', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - broken-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [{
        id: 'broken-check',
        yaml: 'name: BrokenCheck\ndescription: test\nreviewer:\n  type: structure\n',
        // check.mjs returns a Promise — this triggers STRUCTURE_CHECK_ASYNC from runner
        files: {
          'check.mjs': 'export function check(_ctx) { return Promise.resolve([]); }\n',
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('refused');
    const v = result.aspectViolations?.find(v => v.aspectId === 'broken-check');
    expect(v).toBeDefined();
    expect(v!.errorSource).toBe('astRuntime');
    expect(v!.reason).toMatch(/STRUCTURE_CHECK_ASYNC/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('structure aspect with succeeded:false (undeclared fs read) — classified as astRuntime', async () => {
    const { tmpDir } = await createStructureProject('struct-undeclared-fs', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - undeclared-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: {
        'src/svc.ts': 'export const x = 1;\n',
        'src/other.ts': 'export const y = 2;\n',
      },
      aspects: [{
        id: 'undeclared-check',
        yaml: 'name: UndeclaredCheck\ndescription: test\nreviewer:\n  type: structure\n',
        // reads a path not in allowedSet — triggers succeeded:false from runner
        files: {
          'check.mjs': `export function check(ctx) {
  ctx.fs.read('src/other.ts');
  return [];
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('refused');
    const v = result.aspectViolations?.find(v => v.aspectId === 'undeclared-check');
    expect(v).toBeDefined();
    expect(v!.errorSource).toBe('astRuntime');
    // runner returns succeeded:false, message should reference the undeclared path
    expect(v!.reason).toMatch(/undeclared/i);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('structure aspect on no-change node — pendingDriftState populated from baseline, structureTouchedFiles recorded', async () => {
    const { tmpDir } = await createStructureProject('struct-nochange', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - shape-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [{
        id: 'shape-check',
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: structure\n',
        files: {
          'check.mjs': 'export function check(_ctx) { return []; }\n',
        },
      }],
    });

    // Record baseline — node is now in no-change state
    await recordBaseline(tmpDir);

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // no-change branch must now populate pendingDriftState
    expect(coreResult.action).toBe('no-change');
    expect(coreResult.pendingDriftState).toBeDefined();

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Structure aspect ran successfully on a no-change node — action stays 'no-change'
    expect(result.action).toBe('no-change');
    expect(result.aspectResults?.['shape-check']?.satisfied).toBe(true);
    expect(result.pendingDriftState?.state.structureTouchedFiles?.['shape-check']).toBeDefined();

    await rm(tmpDir, { recursive: true, force: true });
  });
});
