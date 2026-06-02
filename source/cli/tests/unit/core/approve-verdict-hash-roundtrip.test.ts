import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import {
  readNodeDriftState,
  writeNodeDriftState,
} from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { getChildMappingExclusions } from '../../../src/core/approve.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

const NODE_PATH = 'svc/my-service';

async function createTmpProject(name: string): Promise<string> {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-verdict-hash-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', NODE_PATH);
  const parentDir = path.join(yggRoot, 'model', 'svc');

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
  await writeFile(path.join(parentDir, 'yg-node.yaml'), 'name: svc\ntype: service\ndescription: parent\n');
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/index.ts\n',
  );
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');

  // Deterministic aspect (records a checkTouched read-set) + LLM aspect.
  const detDir = path.join(yggRoot, 'aspects', 'det');
  await mkdir(detDir, { recursive: true });
  await writeFile(path.join(detDir, 'yg-aspect.yaml'), 'name: Det\ndescription: structural shape\nreviewer:\n  type: deterministic\n');
  await writeFile(path.join(detDir, 'check.mjs'), 'export function check(_ctx) { return []; }\n');

  const llmDir = path.join(yggRoot, 'aspects', 'llm');
  await mkdir(llmDir, { recursive: true });
  await writeFile(path.join(llmDir, 'yg-aspect.yaml'), 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n');
  await writeFile(path.join(llmDir, 'content.md'), 'Code must be deterministic.\n');

  const srcAbs = path.join(tmpDir, 'src/svc/index.ts');
  await mkdir(path.dirname(srcAbs), { recursive: true });
  await writeFile(srcAbs, 'const x = 1;\n');

  return tmpDir;
}

function makeMockProvider(): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
  };
}

/**
 * Recompute the canonical hash exactly as `yg check` does (core/check.ts:221):
 * fold the STORED per-aspect verdicts into the hash. The bug this guards: if
 * approve stores a hash over a different verdict set than it persists, this
 * recompute will not match `stored.hash` → permanent false drift.
 */
async function checkPathHash(tmpDir: string, stored: DriftNodeState): Promise<string> {
  const graph = await loadGraph(tmpDir);
  const node = graph.nodes.get(NODE_PATH)!;
  const projectRoot = path.dirname(graph.rootPath);
  const { trackedFiles, identity } = collectTrackedFiles(node, graph, stored);
  const excludePrefixes = getChildMappingExclusions(graph, NODE_PATH);
  const storedFileData = { hashes: stored.files, mtimes: stored.mtimes ?? {} };
  const { canonicalHash } = await hashTrackedFiles(
    projectRoot, trackedFiles, storedFileData, excludePrefixes, identity, stored.aspectVerdicts,
  );
  return canonicalHash;
}

async function approveFull(
  tmpDir: string,
): Promise<{ state: DriftNodeState; action: string }> {
  const graph = await loadGraph(tmpDir);
  const coreResult = await approveNode(graph, NODE_PATH);
  const storedEntry = await readNodeDriftState(graph.rootPath, NODE_PATH);
  const result = await runApproveWithReviewer({
    graph,
    nodePath: NODE_PATH,
    result: coreResult,
    rootPath: graph.rootPath,
    secretsByProvider: new Map(),
    storedEntry,
  });
  if (result.action === 'refused') {
    // Surface the reason so a fixture mistake is diagnosable rather than opaque.
    throw new Error(`approve refused: ${JSON.stringify(result.refuseReasonData)} | violations: ${JSON.stringify(result.aspectViolations)}`);
  }
  const written = await readNodeDriftState(graph.rootPath, NODE_PATH);
  expect(written).toBeDefined();
  return { state: written!, action: result.action };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateLlmProvider.mockReturnValue(makeMockProvider());
});

// The round-trip bug-catcher: the stored hash MUST equal a fresh check-path
// recompute over the STORED verdicts. If approve computes its hash over a
// different verdict set than it persists (e.g. the EMPTY initial verdicts while
// the reviewer-applied verdicts are what gets written), every node drifts on the
// very next `yg check`.
describe('verdict-fold hash round-trip (approve stores == check recomputes)', () => {
  it('initial approve: stored hash matches the check-path recompute (no false drift)', async () => {
    const tmpDir = await createTmpProject('initial');
    const { state: stored, action } = await approveFull(tmpDir);
    expect(action).toBe('initial');

    // Verdicts were actually recorded (the reviewer ran).
    expect(stored.aspectVerdicts['llm']).toEqual({ verdict: 'approved' });
    expect(stored.aspectVerdicts['det']).toEqual({ verdict: 'approved' });

    // The stored hash folds those verdicts; the check recompute agrees → no drift.
    expect(await checkPathHash(tmpDir, stored)).toBe(stored.hash);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('re-approve after a source change: stored hash matches the check-path recompute', async () => {
    const tmpDir = await createTmpProject('reapprove');
    await approveFull(tmpDir);

    // Change source AND add a fresh log entry (mandatory log gate on source change).
    const srcAbs = path.join(tmpDir, 'src/svc/index.ts');
    await writeFile(srcAbs, 'const x = 2;\n');
    // Bump mtime to a clearly-later instant so the mtime fast-path in
    // hashTrackedFiles re-hashes the changed file (coarse FS mtime granularity
    // can otherwise collide with the original write within one test tick, which
    // would make approve see no source change — a test artifact, not behavior).
    const future = new Date(Date.now() + 60_000);
    await utimes(srcAbs, future, future);
    // Append a fresh entry to the EXISTING log bytes. Append-only integrity hashes
    // the prefix up to the boundary entry's offsetEnd, which is the START of the
    // next header once a second entry exists. The original file already ends in a
    // newline, so the new header must begin at that exact byte with NO inserted
    // bytes — otherwise the recomputed prefix differs (prefix_modified). Hence no
    // leading newline here.
    await appendFile(
      path.join(tmpDir, '.yggdrasil/model', NODE_PATH, 'log.md'),
      '## [2026-05-12T10:00:00.000Z]\nChanged the constant.\n',
    );

    const { state: stored, action } = await approveFull(tmpDir);
    expect(action).toBe('approved');
    expect(stored.aspectVerdicts['llm']).toEqual({ verdict: 'approved' });
    expect(await checkPathHash(tmpDir, stored)).toBe(stored.hash);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('cascade re-approve (upstream-only aspect change): stored hash matches the check-path recompute', async () => {
    const tmpDir = await createTmpProject('cascade');
    await approveFull(tmpDir);

    // Upstream-only change: edit the LLM aspect content (no source edit, no new
    // log entry required since source is unchanged).
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/llm/content.md'),
      'Code must be deterministic and pure.\n',
    );

    const { state: stored, action } = await approveFull(tmpDir);
    expect(action).toBe('approved');
    expect(stored.aspectVerdicts['llm']).toEqual({ verdict: 'approved' });
    expect(await checkPathHash(tmpDir, stored)).toBe(stored.hash);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('tampering a stored verdict (refused->approved) breaks the hash (caught by check)', async () => {
    const tmpDir = await createTmpProject('tamper');
    const { state: stored } = await approveFull(tmpDir);

    // The honest baseline round-trips.
    expect(await checkPathHash(tmpDir, stored)).toBe(stored.hash);

    // Tamper: hand-edit a stored verdict in the committed baseline, leaving the
    // stored hash untouched (as an attacker editing the JSON would).
    const tampered: DriftNodeState = {
      ...stored,
      aspectVerdicts: { ...stored.aspectVerdicts, llm: { verdict: 'refused', errorSource: 'codeViolation' } },
    };
    const graph = await loadGraph(tmpDir);
    await writeNodeDriftState(graph.rootPath, NODE_PATH, tampered);

    const reread = await readNodeDriftState(graph.rootPath, NODE_PATH);
    // The stored hash (unchanged) no longer matches the recompute over the
    // tampered verdicts → check detects drift.
    expect(await checkPathHash(tmpDir, reread!)).not.toBe(reread!.hash);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
