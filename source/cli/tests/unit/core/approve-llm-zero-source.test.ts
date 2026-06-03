import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { readNodeDriftState } from '../../../src/io/drift-state-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASPECT_YAML =
  'name: Deterministic\ndescription: Pure transforms only\nreviewer:\n  type: llm\n';

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-approve-llm-${name}`);
  const yggRoot = path.join(tmpDir, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', opts.nodePath);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(yggRoot, '.drift-state'), { recursive: true });
  await mkdir(path.join(yggRoot, 'schemas'), { recursive: true });
  await writeFile(path.join(yggRoot, 'schemas', 'yg-node.yaml'), 'type: node\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-aspect.yaml'), 'type: aspect\n');
  await writeFile(path.join(yggRoot, 'schemas', 'yg-flow.yaml'), 'type: flow\n');
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), opts.configYaml ?? V5_REVIEWER_CONFIG);
  await writeFile(path.join(nodeDir, 'yg-node.yaml'), opts.nodeYaml);
  // A log entry exists so the mandatory log gate (log_required + source change)
  // is satisfied. recordBaseline does not capture a log baseline, so this entry
  // counts as "fresh" for any subsequent source change — these tests exercise the
  // reviewer, not the log gate.
  await writeFile(path.join(nodeDir, 'log.md'), '## [2026-05-11T10:00:00.000Z]\nInitial setup.\n');

  // Create parent nodes for nested paths (e.g. 'svc/my-service' needs 'svc' parent)
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

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Fail-closed on zero readable source files (fix 1c) ──────────────────────
//
// FAIL-CLOSED (#2c): when a node has at least one effective non-draft LLM
// aspect but the resolved source-file set is empty, approve must refuse
// (infra, no baseline written). Deterministic-only or zero-aspect nodes
// with no files are unaffected and still approve.

describe('runApproveWithReviewer — zero source files with LLM aspect', () => {
  it('fails closed (infra, no baseline) when an LLM aspect is effective but no source files exist', async () => {
    // Node has a mapping pattern but NO files on disk — sourceFilePaths will be empty.
    const { tmpDir } = await createTmpProject('zero-src-llm', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      // NO mappingFiles — the src/svc/ directory will not exist
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // coreResult must be non-refused for the reviewer to be reached
    expect(coreResult.action).not.toBe('refused');

    // No baseline exists before this call
    const baselineBefore = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(baselineBefore).toBeUndefined();

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Must refuse (infra) — reviewer never saw the code
    expect(result.action).toBe('refused');
    // The llmSkipped flag signals infrastructure, not a code violation
    expect(result.llmSkipped).toBe('unavailable');
    // refuseReasonData must be present and infra-style (what/why/next)
    expect(result.refuseReasonData).toBeDefined();
    expect(result.refuseReasonData!.what).toBeTruthy();
    expect(result.refuseReasonData!.why).toBeTruthy();
    expect(result.refuseReasonData!.next).toBeTruthy();

    // Fail-closed: NO baseline must have been written
    const storedAfter = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(storedAfter).toBeUndefined();

    // The LLM provider must never have been constructed
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('approves cleanly when a deterministic-only node has no source files', async () => {
    const DET_ASPECT_YAML = 'name: StructCheck\ndescription: Structure check\nreviewer:\n  type: deterministic\n';
    const { tmpDir } = await createTmpProject('zero-src-det', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - struct-check\nmapping:\n  - src/svc/\n',
      // NO mappingFiles — src/svc/ directory will not exist
      aspects: [{
        id: 'struct-check',
        yaml: DET_ASPECT_YAML,
        files: { 'check.mjs': 'export function check(ctx) { return []; }' },
      }],
    });

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.action).not.toBe('refused');

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Deterministic-only: must NOT be blocked by the zero-source guard
    expect(result.action).not.toBe('refused');
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();

    await rm(tmpDir, { recursive: true, force: true });
  });
});
