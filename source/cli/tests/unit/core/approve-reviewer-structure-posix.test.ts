/**
 * posix-paths-output for structure-runner touched files.
 *
 * Paths returned by `runStructureAspect` as `touchedFiles` are stored as keys
 * in the pending drift state (`state.files` and `state.deterministicTouchedFiles`).
 * Every path written at this output boundary must use forward-slash separators
 * — on Windows the structure runner could surface backslash paths. This test
 * mocks the structure runner to return a backslash path and asserts the stored
 * keys are normalized to POSIX. (Against the unnormalized code the backslash
 * key is stored verbatim and these assertions fail.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { writeNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock the structure runner so we control the exact `touchedFiles` it returns,
// including a backslash-separated path that the real runner never emits but
// that the output boundary must defensively normalize.
vi.mock('../../../src/structure/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/structure/runner.js')>();
  return {
    ...actual,
    runStructureAspect: vi.fn(),
  };
});

import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { runStructureAspect } from '../../../src/structure/runner.js';
const mockRunStructureAspect = vi.mocked(runStructureAspect);

async function createProject(name: string) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-struct-posix-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc/my-service');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "4.0.0"\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: MyService\ntype: service\ndescription: test\naspects:\n  - shape-check\nmapping:\n  - src/svc.ts\n',
  );
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');
  await mkdir(path.join(yggRoot, 'model', 'svc'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'model', 'svc', 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: parent\n',
  );
  const aspDir = path.join(yggRoot, 'aspects', 'shape-check');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: ShapeCheck\ndescription: test\nreviewer:\n  type: deterministic\n',
  );
  await writeFile(path.join(aspDir, 'check.mjs'), 'export function check(_ctx) { return []; }\n');
  const srcAbs = path.join(tmpDir, 'src/svc.ts');
  await mkdir(path.dirname(srcAbs), { recursive: true });
  await writeFile(srcAbs, 'export const x = 1;\n');
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
      hash: canonicalHash, files: fileHashes, mtimes: fileMtimes,
    });
  }
}

beforeEach(() => { vi.clearAllMocks(); });

describe('runApproveWithReviewer — structure touched-file paths normalized to POSIX', () => {
  it('stores forward-slash keys even when the runner returns a backslash path', async () => {
    const { tmpDir } = await createProject('backslash');
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc.ts'), 'export const x = 2;\n');

    // Runner returns a backslash-separated touched path (Windows shape).
    mockRunStructureAspect.mockResolvedValue({
      violations: [],
      touchedFiles: ['src\\svc.ts'],
      succeeded: true,
    });

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
    const stf = result.pendingDriftState?.state.deterministicTouchedFiles?.['shape-check'] ?? {};
    const keys = Object.keys(stf);
    // The key is normalized to POSIX; no backslash survives into the baseline.
    expect(keys).toContain('src/svc.ts');
    expect(keys.some(k => k.includes('\\'))).toBe(false);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
