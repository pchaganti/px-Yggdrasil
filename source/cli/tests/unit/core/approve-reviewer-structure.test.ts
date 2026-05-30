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

  it('creates a kind:deterministic entry for structure aspects', () => {
    const aspect: AspectDef = {
      id: 's1',
      name: 's1',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const plan = resolveExecutionPlan([aspect], reviewer);
    expect(plan.resolved).toHaveLength(1);
    expect(plan.resolved[0]).toMatchObject({ kind: 'deterministic', aspect: { id: 's1' } });
  });

  it('does not invoke tier resolution for structure aspects', () => {
    const aspect: AspectDef = {
      id: 's2',
      name: 's2',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const plan = resolveExecutionPlan([aspect], { tiers: {} } as ReviewerConfig);
    expect(plan.errors).toHaveLength(0);
    expect(plan.resolved[0]).toMatchObject({ kind: 'deterministic' });
  });

  it('includes ast, structure, and llm aspects in the plan — ast+structure share the deterministic kind', () => {
    const astAspect: AspectDef = {
      id: 'a1',
      name: 'a1',
      reviewer: { type: 'deterministic' },
      artifacts: [],
      description: 'd',
    } as unknown as AspectDef;
    const structAspect: AspectDef = {
      id: 's1',
      name: 's1',
      reviewer: { type: 'deterministic' },
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
    // Former-ast and structure both resolve to 'deterministic'; LLM stays 'llm'.
    expect(plan.resolved.find(e => e.aspect.id === 'a1')!.kind).toBe('deterministic');
    expect(plan.resolved.find(e => e.aspect.id === 's1')!.kind).toBe('deterministic');
    expect(plan.resolved.find(e => e.aspect.id === 'l1')!.kind).toBe('llm');
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
  // A log entry exists so the mandatory log gate (log_required + source change)
  // is satisfied — these tests exercise structure-aspect dispatch, not the log
  // gate. recordBaseline does not capture a log baseline, so this entry counts
  // as "fresh" for any subsequent source change.
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');

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
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
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

  it('cross-node touched file (declared relation read) — hashed from disk into structureTouchedFiles', async () => {
    // A structure aspect on svc/my-service reads src/dep.ts, owned by the
    // RELATED node svc/dep (declared via a `uses` relation, so the read is
    // allowed). src/dep.ts lands in structResult.touchedFiles but is NOT in
    // this node's state.files (which only carries own-mapping src/svc.ts).
    // That makes the `if (!hash)` branch in dispatchStructureAspects true: the
    // cross-node path is hashed from disk and recorded under
    // structureTouchedFiles[aspectId], without leaking into state.files.
    const { tmpDir } = await createStructureProject('struct-crossnode', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - reads-dep',
        'relations:',
        '  - target: svc/dep',
        '    type: uses',
        'mapping:',
        '  - src/svc.ts',
      ].join('\n') + '\n',
      mappingFiles: {
        'src/svc.ts': 'export const x = 1;\n',
        'src/dep.ts': 'export const d = 1;\n',
      },
      aspects: [{
        id: 'reads-dep',
        yaml: 'name: ReadsDep\ndescription: test\nreviewer:\n  type: deterministic\n',
        // Reads the related node's file via ctx.fs — adds src/dep.ts to touchedFiles.
        files: {
          'check.mjs': `export function check(ctx) {
  ctx.fs.read('src/dep.ts');
  return [];
}\n`,
        },
      }],
      parentNodes: [
        { path: 'svc', yaml: 'name: Svc\ntype: service\ndescription: parent\n' },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\nmapping:\n  - src/dep.ts\n',
        },
      ],
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
    expect(result.aspectResults?.['reads-dep']?.satisfied).toBe(true);

    // The cross-node touched path is recorded under structureTouchedFiles with a
    // real disk hash (proving the `if (!hash)` branch ran)...
    const stf = result.pendingDriftState?.state.structureTouchedFiles?.['reads-dep'];
    expect(stf).toBeDefined();
    expect(stf!['src/dep.ts']).toMatch(/^[a-f0-9]+$/);
    // ...but it must NOT leak into this node's canonical own-source map.
    expect(result.pendingDriftState?.state.files['src/dep.ts']).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cross-node touched file missing on disk — hashFile throws, path skipped, run still completes', async () => {
    // Same cross-node wiring, but the related node's file is deleted before the
    // reviewer runs. The structure check reads it once (caching the content via
    // the runner), so the path enters touchedFiles, yet hashFile(abs) in
    // dispatchStructureAspects throws (file gone). The catch's `continue` must
    // skip the path: the run still completes and the missing path is simply
    // absent from the recorded structureTouchedFiles hashes.
    const { tmpDir } = await createStructureProject('struct-crossnode-missing', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - reads-dep',
        'relations:',
        '  - target: svc/dep',
        '    type: uses',
        'mapping:',
        '  - src/svc.ts',
      ].join('\n') + '\n',
      mappingFiles: {
        'src/svc.ts': 'export const x = 1;\n',
        'src/dep.ts': 'export const d = 1;\n',
      },
      aspects: [{
        id: 'reads-dep',
        yaml: 'name: ReadsDep\ndescription: test\nreviewer:\n  type: deterministic\n',
        // Reads the related file, then deletes it so the post-run hashFile fails.
        files: {
          'check.mjs': `import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
export function check(ctx) {
  // Touch the cross-node path (adds it to touchedFiles), then remove it on disk.
  ctx.fs.exists('src/dep.ts');
  const abs = resolve('${path.join(__dirname, '../../fixtures/tmp-struct-struct-crossnode-missing')}', 'src/dep.ts');
  if (existsSync(abs)) rmSync(abs);
  return [];
}\n`,
        },
      }],
      parentNodes: [
        { path: 'svc', yaml: 'name: Svc\ntype: service\ndescription: parent\n' },
        {
          path: 'svc/dep',
          yaml: 'name: Dep\ntype: service\ndescription: dependency\nmapping:\n  - src/dep.ts\n',
        },
      ],
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

    // Run still completes — the missing cross-node path was skipped, not fatal.
    expect(result.action).toBe('approved');
    expect(result.aspectResults?.['reads-dep']?.satisfied).toBe(true);
    const stf = result.pendingDriftState?.state.structureTouchedFiles?.['reads-dep'];
    expect(stf).toBeDefined();
    // The deleted cross-node path is absent from recorded hashes (catch → continue).
    expect(stf!['src/dep.ts']).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('structure aspect with violations — refused and violation message includes file:line', async () => {
    const { tmpDir } = await createStructureProject('struct-violated', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - shape-check\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [{
        id: 'shape-check',
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
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
        yaml: 'name: BrokenCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
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
        yaml: 'name: UndeclaredCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
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
        yaml: 'name: ShapeCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
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

describe('D8.3 — structureTouchedFiles carry-forward for draft-skipped structure aspects', () => {
  it('preserves baseline structureTouchedFiles for draft-skipped structure aspects (D8.3)', async () => {
    // Aspect A = enforced structure aspect, Aspect B = draft structure aspect.
    // Seed a baseline where both A and B have structureTouchedFiles entries.
    // Run approve — B is skipped (draft), but its entry must be preserved verbatim.
    const { tmpDir, yggRoot } = await createStructureProject('d83-carry', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - shape-a',
        '  - shape-b',
        'mapping:',
        '  - src/svc.ts',
      ].join('\n') + '\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [
        {
          id: 'shape-a',
          yaml: 'name: ShapeA\ndescription: test\nreviewer:\n  type: deterministic\nstatus: enforced\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'shape-b',
          yaml: 'name: ShapeB\ndescription: test\nreviewer:\n  type: deterministic\nstatus: draft\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
      ],
    });

    // Record baseline — with seeded structureTouchedFiles for BOTH aspects (A and B).
    await recordBaseline(tmpDir);
    const graph0 = await loadGraph(tmpDir);
    for (const [nodePath, node] of graph0.nodes) {
      if (!node.meta.mapping) continue;
      const trackedFiles = collectTrackedFiles(node, graph0);
      const projectRoot = path.dirname(graph0.rootPath);
      const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
        projectRoot, trackedFiles, undefined, [],
      );
      await writeNodeDriftState(graph0.rootPath, nodePath, {
        hash: canonicalHash,
        files: fileHashes,
        mtimes: fileMtimes,
        // Seed structureTouchedFiles for both aspects — simulating a prior enforce-both approve
        structureTouchedFiles: {
          'shape-a': { 'src/svc.ts': 'aaa111' },
          'shape-b': { 'src/svc.ts': 'bbb222' },
        },
      });
    }

    // Read the baseline BEFORE modifying source (this is the entry with shape-b stf)
    const { readNodeDriftState } = await import('../../../src/io/drift-state-store.js');
    const seededBaseline = await readNodeDriftState(yggRoot, 'svc/my-service');
    expect(seededBaseline?.structureTouchedFiles?.['shape-b']).toMatchObject({ 'src/svc.ts': 'bbb222' });

    // Modify source so approve runs (approved, not no-change)
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.action).toBe('approved');

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: seededBaseline,
    });

    // shape-b was skipped (draft) — its prior structureTouchedFiles entry must be preserved
    const stf = result.pendingDriftState?.state.structureTouchedFiles;
    expect(stf).toBeDefined();
    // shape-a ran and may update its entry
    expect(stf!['shape-a']).toBeDefined();
    // shape-b was draft-skipped — must carry forward the prior entry
    expect(stf!['shape-b']).toMatchObject({ 'src/svc.ts': 'bbb222' });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('D8.3 skip branch — non-structure draft aspects do not affect structureTouchedFiles', async () => {
    // Draft aspect C is LLM type (not structure). The D8.3 loop must skip it without crashing.
    // No prior structureTouchedFiles for llm-draft since it is not structure type.
    const { tmpDir } = await createStructureProject('d83-llm-draft', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - shape-a',
        '  - llm-draft',
        'mapping:',
        '  - src/svc.ts',
      ].join('\n') + '\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      configYaml: 'version: "4.0.0"\n',
      aspects: [
        {
          id: 'shape-a',
          yaml: 'name: ShapeA\ndescription: test\nreviewer:\n  type: deterministic\nstatus: enforced\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'llm-draft',
          // LLM aspect marked draft — skipped, but not structure type → D8.3 should hit continue
          yaml: 'name: LlmDraft\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Some rule.\n' },
        },
      ],
    });

    await recordBaseline(tmpDir);
    // Seed baseline with structureTouchedFiles (only for shape-a, llm-draft has none)
    const { readNodeDriftState: rds, writeNodeDriftState: wds } = await import('../../../src/io/drift-state-store.js');
    const priorState = await rds(path.join(tmpDir, '.yggdrasil'), 'svc/my-service');
    if (priorState) {
      await wds(path.join(tmpDir, '.yggdrasil'), 'svc/my-service', {
        ...priorState,
        structureTouchedFiles: { 'shape-a': { 'src/svc.ts': 'aaa111' } },
      });
    }

    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');
    const storedEntry2 = await rds(path.join(tmpDir, '.yggdrasil'), 'svc/my-service');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: storedEntry2,
    });

    expect(result.action).toBe('approved');
    // shape-a ran (structure, enforced) — stf updated
    // llm-draft was skipped — D8.3 loop hit continue (type !== 'deterministic'), no crash
    const stf = result.pendingDriftState?.state.structureTouchedFiles;
    expect(stf?.['shape-a']).toBeDefined();
    // llm-draft has no structureTouchedFiles entry (it is not structure type)
    expect(stf?.['llm-draft']).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('filtered approve carries forward a non-targeted enforced structure aspect\'s structureTouchedFiles', async () => {
    // Two ENFORCED structure aspects on one node: shape-a + shape-b. A filtered
    // approve (`yg approve --aspect shape-a`) runs only shape-a's runner. shape-b
    // is enforced (not draft) but filter-excluded this run. Its prior
    // structureTouchedFiles entry must be carried forward — otherwise its touched
    // files silently drop out of the node's drift identity and impact blast-radius.
    const { tmpDir, yggRoot } = await createStructureProject('filter-carry', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - shape-a',
        '  - shape-b',
        'mapping:',
        '  - src/svc.ts',
      ].join('\n') + '\n',
      mappingFiles: { 'src/svc.ts': 'export const x = 1;\n' },
      aspects: [
        {
          id: 'shape-a',
          yaml: 'name: ShapeA\ndescription: test\nreviewer:\n  type: deterministic\nstatus: enforced\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'shape-b',
          yaml: 'name: ShapeB\ndescription: test\nreviewer:\n  type: deterministic\nstatus: enforced\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
      ],
    });

    // Record baseline, then seed structureTouchedFiles for BOTH enforced aspects.
    await recordBaseline(tmpDir);
    const graph0 = await loadGraph(tmpDir);
    for (const [nodePath, node] of graph0.nodes) {
      if (!node.meta.mapping) continue;
      const trackedFiles = collectTrackedFiles(node, graph0);
      const projectRoot = path.dirname(graph0.rootPath);
      const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
        projectRoot, trackedFiles, undefined, [],
      );
      await writeNodeDriftState(graph0.rootPath, nodePath, {
        hash: canonicalHash,
        files: fileHashes,
        mtimes: fileMtimes,
        structureTouchedFiles: {
          'shape-a': { 'src/svc.ts': 'aaa111' },
          'shape-b': { 'src/other.ts': 'bbb222' },
        },
      });
    }

    const { readNodeDriftState } = await import('../../../src/io/drift-state-store.js');
    const seededBaseline = await readNodeDriftState(yggRoot, 'svc/my-service');
    expect(seededBaseline?.structureTouchedFiles?.['shape-b']).toMatchObject({ 'src/other.ts': 'bbb222' });

    // Modify source so approve runs (approved, not no-change).
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.action).toBe('approved');

    // Filtered approve — only shape-a is freshly evaluated this run.
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: seededBaseline,
      filterAspectId: 'shape-a',
    });

    const stf = result.pendingDriftState?.state.structureTouchedFiles;
    expect(stf).toBeDefined();
    // shape-a ran this run — its entry is present (freshly evaluated).
    expect(stf!['shape-a']).toBeDefined();
    // shape-b was filter-excluded (enforced, not draft) — its prior entry must survive.
    expect(stf!['shape-b']).toMatchObject({ 'src/other.ts': 'bbb222' });

    await rm(tmpDir, { recursive: true, force: true });
  });
});
