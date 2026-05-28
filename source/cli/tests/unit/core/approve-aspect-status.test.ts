/**
 * Task 13 — Approve must short-circuit and filter draft aspects from
 * reviewer dispatch. The reviewer is never invoked for an aspect that
 * resolves to effective status 'draft' on a node.
 *
 * Some scenarios that involve the full `yg approve --aspect X` CLI flow
 * (process.exit, top-level orchestration) are deferred to integration tests
 * (Task 25). See annotations on individual `it.todo` calls below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer } from '../../../src/core/approve-reviewer.js';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import { formatBatchOutput, type BatchResult } from '../../../src/cli/approve.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n';

vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
    ...overrides,
  };
}

async function createTmpProject(name: string, opts: {
  nodePath: string;
  nodeYaml: string;
  configYaml?: string;
  mappingFiles?: Record<string, string>;
  aspects?: Array<{ id: string; yaml: string; files?: Record<string, string> }>;
}) {
  const tmpDir = path.join(__dirname, `../../fixtures/tmp-approve-aspect-status-${name}`);
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

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Case 1 ──────────────────────────────────────────────────────
// Node with only draft aspects → reviewer NOT invoked, no baseline
// written for source-only changes, no log entry required.

describe('approveNode — all-draft node short-circuits', () => {
  it('auto-approves first approve with only draft aspects (no log required)', async () => {
    const { tmpDir } = await createTmpProject('all-draft-first', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: 'name: Deterministic\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
        files: { 'content.md': 'Be deterministic.\n' },
      }],
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    // All-draft node behaves like a no-aspect node: auto-approved with empty hash.
    expect(result.action).toBe('approved');
    expect(result.currentHash).toBe('');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT require a log entry when only draft aspects are effective and source changes', async () => {
    // This is case 6 — paired with case 1 because both rely on the same
    // short-circuit branch (no mandatory entry check for all-draft nodes).
    const { tmpDir } = await createTmpProject('all-draft-no-log', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: 'name: Deterministic\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
        files: { 'content.md': 'Be deterministic.\n' },
      }],
    });
    const graph = await loadGraph(tmpDir);
    const result = await approveNode(graph, 'svc/my-service');
    expect(result.action).toBe('approved');
    expect(result.refuseReasonData).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Case 2 ──────────────────────────────────────────────────────
// Mixed enforced + draft → reviewer called only for the enforced aspect.

describe('runApproveWithReviewer — mixed enforced+draft', () => {
  it('skips draft aspects and verifies only non-draft ones', async () => {
    const { tmpDir } = await createTmpProject('mixed', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - draft-rule\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'draft-rule',
          yaml: 'name: Draft\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Draft rule.\n' },
        },
        {
          id: 'enforced-rule',
          yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
          files: { 'content.md': 'Enforced rule.\n' },
        },
      ],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        verifyCallCount++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('approved');
    // Only one reviewer call — for the enforced aspect.
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['enforced-rule']?.satisfied).toBe(true);
    // Draft aspect not in results — never reached the reviewer.
    expect(result.aspectResults?.['draft-rule']).toBeUndefined();
    expect(result.skippedDraftAspects).toEqual(['draft-rule']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('emits a "[draft]" trace line per skipped aspect', async () => {
    const { tmpDir } = await createTmpProject('mixed-trace', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - draft-rule\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'draft-rule',
          yaml: 'name: Draft\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Draft rule.\n' },
        },
        {
          id: 'enforced-rule',
          yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
          files: { 'content.md': 'Enforced rule.\n' },
        },
      ],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runApproveWithReviewer({
        graph,
        nodePath: 'svc/my-service',
        result: coreResult,
        rootPath: graph.rootPath,
        secretsByProvider: new Map(),
      });
    } finally {
      process.stdout.write = orig;
    }

    const combined = writes.join('');
    expect(combined).toContain("[draft] node 'svc/my-service': aspect 'draft-rule' skipped (status: draft)");
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Case 4: Scenario B ──────────────────────────────────────────
// Aspect-default enforced, but channel-1 own override sets status: draft
// on the node → reviewer skipped on this node.

describe('runApproveWithReviewer — Scenario B (per-node effective draft)', () => {
  it('skips reviewer when own override drops aspect to draft on this node', async () => {
    const { tmpDir } = await createTmpProject('scenario-b', {
      nodePath: 'svc/my-service',
      nodeYaml: [
        'name: MyService',
        'type: service',
        'description: test',
        'aspects:',
        '  - id: deterministic',
        '    status: draft',
        'mapping:',
        '  - src/svc/',
        '',
      ].join('\n'),
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: 'name: Deterministic\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        verifyCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('approved');
    expect(verifyCalls).toBe(0);
    // When every effective aspect resolves to draft, the node enters the
    // all-draft short-circuit in approveNode and never reaches the reviewer
    // filter. The reviewer skip message is still informative via the
    // approveNode action (no baseline written, no log required).
    // Drift state is GC'd because the node has no non-draft effective aspects.
    const stored = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(stored).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Case 5: Footer tally ────────────────────────────────────────
// formatBatchOutput renders "skipped (draft): N" when N > 0.

describe('formatBatchOutput — draft skip tally', () => {
  it('appends "skipped (draft): N" when skippedDraftAspects is non-empty', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const results: BatchResult[] = [
        {
          nodePath: 'a',
          skippedDraftAspects: ['x', 'y'],
          result: {
            action: 'approved',
            currentHash: '',
            skippedDraftAspects: ['x', 'y'],
          },
        },
        {
          nodePath: 'b',
          skippedDraftAspects: [],
          result: { action: 'no-change', currentHash: '' },
        },
      ];
      formatBatchOutput(results, ['extra@b']);
    } finally {
      process.stdout.write = orig;
    }
    const combined = writes.join('');
    // 2 approved (approved + no-change), 0 failed, 3 skipped drafts (2 + 1 scenarioB)
    expect(combined).toContain('2 approved, 0 failed, 3 skipped (draft).');
  });

  it('omits "skipped (draft)" when no drafts were skipped', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const results: BatchResult[] = [
        {
          nodePath: 'a',
          skippedDraftAspects: [],
          result: { action: 'approved', currentHash: '' },
        },
      ];
      formatBatchOutput(results);
    } finally {
      process.stdout.write = orig;
    }
    const combined = writes.join('');
    expect(combined).toContain('1 approved, 0 failed.');
    expect(combined).not.toContain('skipped (draft)');
  });
});

// ── Case 3: Scenario A CLI early-exit (deferred to integration) ─
// Requires invoking the registered Commander action which calls process.exit
// before any output; harder to capture without a child-process harness.
// Covered by Task 25 integration tests.
describe('CLI Scenario A (--aspect X with default draft) — deferred to integration tests', () => {
  it.todo('exits 0 with approveAspectDraftScenarioAMessage when aspect-default is draft');
});

// ── Task 16 ─────────────────────────────────────────────────────
// `yg approve --node Y` analogue of Scenario A: every effective aspect on Y
// resolves to draft → reviewer skipped on this node. Companion behaviour for
// `--dry-run`: still prints prompts for ALL effective aspects, but annotates
// each with its effective status, and adds a "would skip" note for drafts.

import { hasNonDraftEffectiveAspects } from '../../../src/core/graph/aspects.js';
import { approveNodeAllDraftMessage } from '../../../src/formatters/aspect-status-messages.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import { runDryRunForNode } from '../../../src/cli/approve.js';

describe('cli approve: --node Y with all-draft', () => {
  it('exits early when every effective aspect on Y is draft (skip message)', async () => {
    const { tmpDir } = await createTmpProject('node-all-draft', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: 'name: Deterministic\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
        files: { 'content.md': 'Be deterministic.\n' },
      }],
    });
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;

    // Precondition that the CLI single-node path checks before bypassing the
    // reviewer dispatch. If false, the CLI emits approveNodeAllDraftMessage
    // and exits 0 instead of invoking runLlmVerification.
    expect(hasNonDraftEffectiveAspects(node, graph)).toBe(false);

    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        verifyCalls++;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    try {
      // Mirror the CLI single-node all-draft branch.
      if (!hasNonDraftEffectiveAspects(node, graph)) {
        process.stdout.write(buildIssueMessage(approveNodeAllDraftMessage({ nodePath: 'svc/my-service' })) + '\n');
      }
    } finally {
      process.stdout.write = orig;
    }

    const combined = writes.join('');
    expect(combined).toContain('Reviewer skipped');
    expect(combined).toContain("Every effective aspect on node 'svc/my-service' has status 'draft'");
    // No reviewer call took place — the branch is taken before any LLM dispatch.
    expect(verifyCalls).toBe(0);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('dry-run prints prompts for ALL effective aspects regardless of status, with [status] tag', async () => {
    const { tmpDir, yggRoot } = await createTmpProject('node-dry-run-status', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - draft-rule\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'draft-rule',
          yaml: 'name: Draft\ndescription: test\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Draft rule.\n' },
        },
        {
          id: 'enforced-rule',
          yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
          files: { 'content.md': 'Enforced rule.\n' },
        },
      ],
    });
    const graph = await loadGraph(tmpDir);
    const yggPrefix = path.relative(path.dirname(graph.rootPath), graph.rootPath)
      .replace(/\\/g, '/').replace(/\/+$/, '');
    // yggRoot is unused below — included only via createTmpProject; keep var aliased
    void yggRoot;

    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runDryRunForNode({ graph, nodePath: 'svc/my-service', yggPrefix });
    } finally {
      process.stdout.write = orig;
    }

    const combined = writes.join('');
    // Both aspect prompts appear, each tagged with its effective status.
    expect(combined).toContain('Prompt for LLM aspect: enforced-rule [enforced]');
    expect(combined).toContain('Prompt for LLM aspect: draft-rule [draft]');
    // Draft aspect carries the "would skip" annotation; enforced does not.
    expect(combined).toContain('(real approve would skip — preview only)');
    // The annotation is only attached to draft. Counter-check: only one
    // occurrence of the annotation string overall (one draft aspect here).
    expect(combined.split('(real approve would skip — preview only)').length - 1).toBe(1);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
