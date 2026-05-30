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

// ── Phase-4 routing: former-ast aspects go through the STRUCTURE runner ──
//
// The `reviewer.type` enum is still { llm, ast, structure }, but BOTH `ast`
// and `structure` now resolve to a single deterministic execution kind that
// dispatches through runStructureAspect. These tests pin that an `ast`-type
// aspect:
//   - runs via the structure path (ctx.files available, violation shape passes
//     the structure runner's validation),
//   - honors yg-suppress on the violation line (shared suppress),
//   - sees the structure runner's buildOwnFiles set (child-mapped paths
//     excluded — the accepted file-set delta).

async function createProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
  parentNodes?: Array<{ path: string; yaml: string }>;
  childNodes?: Array<{ path: string; yaml: string }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-former-ast-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), opts.configYaml ?? 'version: "4.0.0"\n');
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);
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

  if (opts.childNodes) {
    for (const cn of opts.childNodes) {
      const cDir = path.join(yggRoot, 'model', cn.path);
      await mkdir(cDir, { recursive: true });
      await writeFile(path.join(cDir, 'yg-node.yaml'), cn.yaml);
      await writeFile(path.join(cDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');
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

const AST_ASPECT_YAML = 'name: NoX\ndescription: forbids x\nreviewer:\n  type: deterministic\nlanguage:\n  - typescript\n';

describe('resolveExecutionPlan — former-ast and structure collapse to a single deterministic kind', () => {
  const reviewer: ReviewerConfig = {
    default: 'default',
    tiers: {
      default: { provider: 'ollama', model: 'x', temperature: 0, consensus: 1, max_tokens: 'auto' },
    },
  } as unknown as ReviewerConfig;

  it('an ast-type aspect resolves to the SAME deterministic kind as a structure-type aspect', () => {
    const astAspect = { id: 'a1', name: 'a1', reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' } as unknown as AspectDef;
    const structAspect = { id: 's1', name: 's1', reviewer: { type: 'deterministic' }, artifacts: [], description: 'd' } as unknown as AspectDef;
    const plan = resolveExecutionPlan([astAspect, structAspect], reviewer);
    expect(plan.errors).toHaveLength(0);
    expect(plan.resolved).toHaveLength(2);
    // Both former-ast and structure now share ONE non-llm execution kind.
    const kinds = new Set(plan.resolved.map(e => e.kind));
    expect(kinds.size).toBe(1);
    expect(plan.resolved.find(e => e.aspect.id === 'a1')!.kind)
      .toBe(plan.resolved.find(e => e.aspect.id === 's1')!.kind);
    // It is NOT the llm kind.
    expect([...kinds][0]).not.toBe('llm');
  });
});

describe('runApproveWithReviewer — former-ast aspect routed through the structure runner', () => {
  it('reports a violation produced by an ast-type check that reads ctx.files', async () => {
    const { tmpDir } = await createProject('ast-violates', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-x\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const ok = 1;\nexport const bad = 2;\n' },
      aspects: [{
        id: 'no-x',
        yaml: AST_ASPECT_YAML,
        files: {
          // AST-style check: reads ctx.files, returns AST violation shape.
          'check.mjs': `export function check(ctx) {
  const f = ctx.files.find(f => f.path.endsWith('.ts'));
  if (!f) return [];
  return [{ file: f.path, line: 2, column: 0, message: 'bad found' }];
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const ok = 1;\nexport const bad = 3;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Routed through the structure runner: the AST-shape violation passes the
    // structure runner's validation and refuses an enforced aspect.
    expect(result.action).toBe('refused');
    const v = result.aspectViolations?.find(v => v.aspectId === 'no-x');
    expect(v).toBeDefined();
    expect(v!.errorSource).toBe('codeViolation');
    expect(v!.reason).toMatch(/src\/svc\.ts:2: bad found/);
    // structure runner records own-file footprint for the former-ast aspect.
    expect(result.pendingDriftState?.state.deterministicTouchedFiles?.['no-x']).toBeDefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('honors a yg-suppress comment for the violation line of a former-ast aspect', async () => {
    // A single-line yg-suppress marker covers the line AFTER it, so the marker
    // sits on line 2 and the violation lands on line 3.
    const { tmpDir } = await createProject('ast-suppressed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-x\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const ok = 1;\n// yg-suppress(no-x) known debt\nexport const bad = 2;\n' },
      aspects: [{
        id: 'no-x',
        yaml: AST_ASPECT_YAML,
        files: {
          'check.mjs': `export function check(ctx) {
  const f = ctx.files.find(f => f.path.endsWith('.ts'));
  if (!f) return [];
  return [{ file: f.path, line: 3, column: 0, message: 'bad found' }];
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(
      path.join(tmpDir, 'src/svc.ts'),
      'export const ok = 1;\n// yg-suppress(no-x) known debt\nexport const bad = 3;\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Suppress on the violation line filters it out — node approves.
    expect(result.action).toBe('approved');
    expect(result.aspectResults?.['no-x']?.satisfied).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('a clean former-ast aspect approves through the structure path', async () => {
    const { tmpDir } = await createProject('ast-clean', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-x\nmapping:\n  - src/svc.ts\n',
      mappingFiles: { 'src/svc.ts': 'export const ok = 1;\n' },
      aspects: [{
        id: 'no-x',
        yaml: AST_ASPECT_YAML,
        files: {
          'check.mjs': `export function check(ctx) {
  // Touch ctx.files so the structure path is genuinely exercised.
  void ctx.files.length;
  return [];
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const ok = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('approved');
    expect(result.aspectResults?.['no-x']?.satisfied).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('former-ast aspect sees the structure buildOwnFiles set — child-mapped paths excluded (accepted delta-d)', async () => {
    // Parent maps the whole src/ dir; a child node carves out src/child.ts. The
    // structure runner's buildOwnFiles EXCLUDES the child-mapped path, so the
    // former-ast check on the parent sees only src/parent.ts — never src/child.ts.
    const { tmpDir } = await createProject('ast-carveout', {
      nodePath: 'svc/parent',
      nodeYaml: [
        'name: Parent',
        'type: service',
        'description: test',
        'aspects:',
        '  - count-files',
        'mapping:',
        '  - src/parent.ts',
        '  - src/child.ts',
      ].join('\n') + '\n',
      mappingFiles: {
        'src/parent.ts': 'export const p = 1;\n',
        'src/child.ts': 'export const c = 1;\n',
      },
      parentNodes: [
        { path: 'svc', yaml: 'name: Svc\ntype: service\ndescription: parent\n' },
      ],
      childNodes: [
        { path: 'svc/parent/child', yaml: 'name: Child\ntype: service\ndescription: child\nmapping:\n  - src/child.ts\n' },
      ],
      aspects: [{
        id: 'count-files',
        yaml: 'name: CountFiles\ndescription: pins the own-file set\nreviewer:\n  type: deterministic\nlanguage:\n  - typescript\n',
        files: {
          // Emit one violation per own file path so we can assert the exact set.
          'check.mjs': `export function check(ctx) {
  return ctx.files.map(f => ({ file: f.path, line: 1, column: 0, message: 'seen ' + f.path }));
}\n`,
        },
      }],
    });

    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/parent.ts'), 'export const p = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/parent');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/parent',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    const reason = result.aspectViolations?.find(v => v.aspectId === 'count-files')?.reason ?? '';
    // Parent's own file is reported...
    expect(reason).toMatch(/src\/parent\.ts/);
    // ...but the child-mapped path is carved out of the structure own-file set.
    expect(reason).not.toMatch(/src\/child\.ts/);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
