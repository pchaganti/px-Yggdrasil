/**
 * Task 26a — parseCache sharing between AST and structure dispatchers.
 *
 * Contract: within a single runApproveWithReviewer call, both the AST-aspect
 * runner and the structure-aspect runner share ONE ParseCache (astParseCache in
 * approve-reviewer.ts). This means a TypeScript file touched by BOTH an AST
 * aspect and a structure aspect is parsed only once, not twice.
 *
 * Test strategy: spy on parseFile from ast/parser.ts (the innermost parse
 * function), run runApproveWithReviewer with a node that has both an AST aspect
 * and a structure aspect touching the same .ts file, assert parseFile was called
 * exactly once for that file.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createProject(name: string) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-parsecache-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc', 'my-service');

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });

  // Create parent node (svc/) required by loader for nested paths
  await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
    `name: svc\ntype: module\ndescription: parent grouping\n`,
  );

  // Minimal schema stubs — loader only checks existence
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');

  // Config: no reviewer needed (aspects are ast + structure, not llm)
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.0.0"\n');

  // Architecture: one service type
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    `node_types:
  module:
    description: Logical grouping
    log_required: false
  service:
    description: Service
    log_required: false
    parents: [module]
    when:
      path: "**"
`,
  );

  // Node with both AST and structure aspects on shared.ts
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    `name: MyService\ntype: service\ndescription: test\naspects:\n  - astrule\n  - structrule\nmapping:\n  - src/shared.ts\n`,
  );

  // Mapping file
  await mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await writeFile(path.join(tmpDir, 'src', 'shared.ts'), 'export const x = 1;\n');

  // AST aspect: checks TypeScript files
  await mkdir(path.join(yggRoot, 'aspects', 'astrule'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'aspects', 'astrule', 'yg-aspect.yaml'),
    `name: AstRule\ndescription: ast aspect touching shared.ts\nreviewer:\n  type: deterministic\nlanguage:\n  - typescript\n`,
  );
  await writeFile(
    path.join(yggRoot, 'aspects', 'astrule', 'check.mjs'),
    // Trivially passes — we care about parseFile call count, not violations
    `export function check(_ctx) { return []; }\n`,
  );

  // Structure aspect: also requests parseAst for shared.ts
  await mkdir(path.join(yggRoot, 'aspects', 'structrule'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'aspects', 'structrule', 'yg-aspect.yaml'),
    `name: StructRule\ndescription: structure aspect touching shared.ts\nreviewer:\n  type: deterministic\n`,
  );
  // check.mjs requests parseAst for src/shared.ts — tests cache hit via prewarmupAstCache
  await writeFile(
    path.join(yggRoot, 'aspects', 'structrule', 'check.mjs'),
    // Does NOT call ctx.parseAst — the cache sharing is tested via prewarmupAstCache
    // inside the runner, not via ctx.parseAst in check(). The runner always prewarms
    // the own files before calling check().
    `export function check(ctx) {
  // Verify src/shared.ts is in the node's own files (it was read at least once)
  const sharedFile = ctx.files.find(f => f.path.includes('shared.ts'));
  if (!sharedFile) return [{ message: 'shared.ts not in files' }];
  return [];
}\n`,
  );

  return { tmpDir, yggRoot };
}

// ---------------------------------------------------------------------------
// Baseline helpers (mirrors approve-reviewer unit test pattern)
// ---------------------------------------------------------------------------

async function setupBaseline(tmpDir: string) {
  const { loadGraph } = await import('../../src/core/graph-loader.js');
  const { collectTrackedFiles } = await import('../../src/core/graph/files.js');
  const { hashTrackedFiles } = await import('../../src/io/hash.js');
  const { writeNodeDriftState } = await import('../../src/io/drift-state-store.js');

  const graph = await loadGraph(tmpDir);
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    if (!node.meta.mapping) continue;
    const trackedFiles = collectTrackedFiles(node, graph);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('structure runner parseCache sharing', () => {
  it('AST aspect and structure aspect on same node share parseCache: shared.ts is parsed once', async () => {
    const { tmpDir } = await createProject('shared-cache');

    await setupBaseline(tmpDir);

    // Mutate the file to trigger drift, forcing the approve to re-run parsers
    await writeFile(path.join(tmpDir, 'src', 'shared.ts'), 'export const x = 2;\n');

    // Spy on parseFile BEFORE importing the approve modules (ensures spy is active)
    // Use dynamic import to get the module instance for spying
    const parserModule = await import('../../src/ast/parser.js');
    const parseSpy = vi.spyOn(parserModule, 'parseFile');

    try {
      const { loadGraph } = await import('../../src/core/graph-loader.js');
      const { approveNode } = await import('../../src/core/approve.js');
      const { runApproveWithReviewer } = await import('../../src/core/approve-reviewer.js');

      const graph = await loadGraph(tmpDir);
      const coreResult = await approveNode(graph, 'svc/my-service');

      await runApproveWithReviewer({
        graph,
        nodePath: 'svc/my-service',
        result: coreResult,
        rootPath: graph.rootPath,
        secretsByProvider: new Map(),
      });

      // Both aspects touched src/shared.ts — but parseFile should be called once.
      // AST runner parses it and puts it in astParseCache.
      // Structure runner's prewarmupAstCache finds it already in cache and skips.
      const callsForShared = parseSpy.mock.calls.filter(
        ([filePath]) => (filePath as string).includes('shared.ts'),
      );
      expect(callsForShared).toHaveLength(1);
    } finally {
      parseSpy.mockRestore();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
