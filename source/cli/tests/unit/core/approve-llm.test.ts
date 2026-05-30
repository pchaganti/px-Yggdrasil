import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { approveNode } from '../../../src/core/approve.js';
import { runApproveWithReviewer, resolveExecutionPlan } from '../../../src/core/approve-reviewer.js';
import { runLlmVerification } from '../../../src/cli/approve.js';
import { writeNodeDriftState, readNodeDriftState } from '../../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../../src/io/hash.js';
import { collectTrackedFiles } from '../../../src/core/graph/files.js';
import type { LlmProvider } from '../../../src/llm/types.js';
import type { AspectDef, ReviewerConfig } from '../../../src/model/graph.js';
import type { DriftNodeState } from '../../../src/model/drift.js';

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

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('runApproveWithReviewer (core layer)', () => {
  it('refuses when LLM aspect not satisfied', async () => {
    const { tmpDir } = await createTmpProject('reviewer-refuse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const mockProvider = makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'Date.now() found', errorSource: 'codeViolation' as const }; },
    });
    mockCreateLlmProvider.mockReturnValue(mockProvider);

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.action).toBe('refused');
    expect(result.aspectViolations?.length).toBeGreaterThan(0);
    expect(result.aspectViolations![0].reason).toContain('Date.now()');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('commits drift state and returns approved when LLM passes', async () => {
    const { tmpDir } = await createTmpProject('reviewer-approve', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.action).toBe('approved');
    expect(result.aspectResults?.['deterministic']?.satisfied).toBe(true);
    const stored = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(stored).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns provider error message when all failures are provider errors', async () => {
    const { tmpDir } = await createTmpProject('reviewer-provider-err', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'network error', errorSource: 'provider' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.action).toBe('refused');
    expect(result.refuseReasonData?.what).toContain('infrastructure failed');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns result unchanged when result.action is already refused', async () => {
    const { tmpDir } = await createTmpProject('reviewer-already-refused', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML }],
    });

    const graph = await loadGraph(tmpDir);
    const alreadyRefused = { action: 'refused' as const, currentHash: '', refuseReasonData: { what: 'pre-refused', why: '', next: '' } };
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: alreadyRefused,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.action).toBe('refused');
    expect(result.refuseReasonData?.what).toBe('pre-refused');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('filters to only filterAspectId when set, skipping other aspects', async () => {
    const { tmpDir } = await createTmpProject('reviewer-filter-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\n  - stable\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        { id: 'deterministic', yaml: ASPECT_YAML, files: { 'content.md': 'Deterministic rules.\n' } },
        { id: 'stable', yaml: 'name: Stable\ndescription: Must be stable\nreviewer:\n  type: llm\n', files: { 'content.md': 'Stable rules.\n' } },
      ],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      filterAspectId: 'deterministic',
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('approved');
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['deterministic']?.satisfied).toBe(true);
    expect(result.aspectResults?.['stable']).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('skips verifyAspects and commits when no LLM aspects exist', async () => {
    const { tmpDir } = await createTmpProject('reviewer-no-llm-aspects', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
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
    // No baseline yet, so first approve commits as 'initial'; the key invariant
    // is that no LLM aspects exist → the reviewer is never constructed.
    expect(result.action).toBe('initial');
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Advisory-status code violations — do NOT refuse ──────────
//
// A code violation of an aspect whose effective status is `advisory` must not
// refuse the node. The baseline is still recorded and the violation is surfaced
// via result.advisoryViolations so the CLI can print an informational line.
// Only enforced code violations (or a mix) refuse. Draft is already skipped.

describe('runApproveWithReviewer — advisory-status code violations', () => {
  it('does NOT refuse when the only violated aspect is advisory (surfaces advisoryViolations)', async () => {
    const { tmpDir } = await createTmpProject('advisory-only', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'advisory-rule',
        yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
        files: { 'content.md': 'Some advisory rule.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'advisory violation found', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // NOT refused — advisory violations warn but do not block.
    expect(result.action).not.toBe('refused');
    expect(result.advisoryViolations).toBeDefined();
    expect(result.advisoryViolations!.map(v => v.aspectId)).toEqual(['advisory-rule']);
    expect(result.advisoryViolations![0].reason).toContain('advisory violation found');
    // Baseline recorded with the refused per-aspect verdict.
    const stored = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(stored?.aspectVerdicts?.['advisory-rule']?.verdict).toBe('refused');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('still refuses when an enforced aspect is violated (regression guard)', async () => {
    const { tmpDir } = await createTmpProject('enforced-violation', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'enforced-rule',
        yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
        files: { 'content.md': 'Some enforced rule.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'enforced violation found', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('refused');
    expect(result.advisoryViolations ?? []).toEqual([]);
    expect(result.aspectViolations!.map(v => v.aspectId)).toContain('enforced-rule');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses on a mix of one advisory + one enforced violation', async () => {
    const { tmpDir } = await createTmpProject('mixed-adv-enf', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\n  - enforced-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'advisory-rule',
          yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
          files: { 'content.md': 'Advisory rule.\n' },
        },
        {
          id: 'enforced-rule',
          yaml: 'name: Enforced\ndescription: test\nreviewer:\n  type: llm\nstatus: enforced\n',
          files: { 'content.md': 'Enforced rule.\n' },
        },
      ],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'violation', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Any enforced violation in the mix → refuse.
    expect(result.action).toBe('refused');
    expect(result.aspectViolations!.map(v => v.aspectId)).toContain('enforced-rule');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT refuse when an advisory AST aspect is violated (short-circuit is status-aware)', async () => {
    const ADV_AST_YAML = 'name: NoConsole\ndescription: No console\nreviewer:\n  type: ast\nlanguage:\n  - typescript\nstatus: advisory\n';
    const { tmpDir } = await createTmpProject('advisory-ast', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - adv-ast\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'adv-ast',
        yaml: ADV_AST_YAML,
        files: {
          'check.mjs': `export function check(ctx) {
  if (ctx.files.length === 0) return [];
  return [{ file: ctx.files[0].path, line: 1, message: 'always fails' }];
}`,
        },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Advisory AST violation must not refuse — and the LLM provider is never
    // constructed because there are no LLM aspects.
    expect(result.action).not.toBe('refused');
    expect(result.advisoryViolations!.map(v => v.aspectId)).toEqual(['adv-ast']);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('LLM verification (CLI layer)', () => {
  it('runs LLM aspect verification and refuses when aspect not satisfied', async () => {
    const { tmpDir } = await createTmpProject('llm-refuse', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        return { satisfied: false, reason: 'Date.now() found — not side-effect free', errorSource: 'codeViolation' as const };
      },
    }));

    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());
    expect(result.action).toBe('refused');
    expect(result.aspectViolations).toBeDefined();
    expect(result.aspectViolations!.length).toBeGreaterThan(0);
    expect(result.aspectViolations![0].reason).toContain('Date.now()');
    expect(result.aspectResults?.['deterministic']?.satisfied).toBe(false);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a non-refused result with advisoryViolations when only an advisory aspect is violated (exit 0 path)', async () => {
    const { tmpDir } = await createTmpProject('llm-advisory', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - advisory-rule\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'advisory-rule',
        yaml: 'name: Advisory\ndescription: test\nreviewer:\n  type: llm\nstatus: advisory\n',
        files: { 'content.md': 'Some advisory rule.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = Date.now();\n');

    const graph = await loadGraph(tmpDir);
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'advisory issue', errorSource: 'codeViolation' as const }; },
    }));

    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());
    // The CLI single-node path only exits 1 when action === 'refused'; this
    // result is approved-family, so the CLI exits 0.
    expect(result.action).not.toBe('refused');
    expect(result.advisoryViolations?.map(v => v.aspectId)).toEqual(['advisory-rule']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('evaluates only filterAspectId aspect when set and no source drift', async () => {
    const { tmpDir } = await createTmpProject('llm-filter-aspect', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\n  - stable\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        { id: 'deterministic', yaml: ASPECT_YAML, files: { 'content.md': 'Deterministic rules.\n' } },
        { id: 'stable', yaml: 'name: Stable\ndescription: Must be stable\nreviewer:\n  type: llm\n', files: { 'content.md': 'Stable rules.\n' } },
      ],
    });
    await recordBaseline(tmpDir);
    // Trigger upstream drift only (change aspect content, not source)
    const aspectContentPath = path.join(tmpDir, '.yggdrasil/aspects/deterministic/content.md');
    await writeFile(aspectContentPath, 'Updated deterministic rules.\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // upstream drift only — changedSource is undefined
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const result = await runLlmVerification(
      graph, 'svc/my-service', coreResult, new Map(), 'deterministic',
    );

    expect(result.action).toBe('approved');
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['deterministic']?.satisfied).toBe(true);
    expect(result.aspectResults?.['stable']).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports LLM unavailable when no reviewer configured', async () => {
    const { tmpDir } = await createTmpProject('llm-skip-unavailable', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{ id: 'deterministic', yaml: ASPECT_YAML }],
      configYaml: 'version: "4.0.0"\n',  // no reviewer section
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());
    expect(result.llmSkipped).toBe('unavailable');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

});

// ── Option 1: reReviewAspectIds (per-aspect re-verification) ──
//
// On an approve where filterAspectId is undefined (--node, --flow cascade,
// parent-redirect), `reReviewAspectIds` restricts reviewer dispatch to the
// drifted subset. Every other effective non-draft aspect is carried forward
// from the prior baseline via the existing carryForward path — no reviewer
// call, prior verdict preserved.

describe('runApproveWithReviewer — reReviewAspectIds (Option 1)', () => {
  // Node with one deterministic structure aspect `det` and one llm aspect `llm`.
  // A prior baseline records both as approved. We drive an upstream-only change
  // (no source edit) so the node re-approves, then restrict dispatch to `det`.
  async function setup(name: string) {
    const { tmpDir } = await createTmpProject(name, {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: structure\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
      ],
    });
    return tmpDir;
  }

  // Record a baseline that carries a prior verdict for BOTH aspects, then induce
  // upstream-only drift (touch the `det` aspect content) so approveNode produces
  // a pendingDriftState without any source change.
  async function recordBaselineWithVerdicts(tmpDir: string): Promise<void> {
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const trackedFiles = collectTrackedFiles(node, graph);
    const projectRoot = path.dirname(graph.rootPath);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [],
    );
    await writeNodeDriftState(graph.rootPath, 'svc/my-service', {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      aspectVerdicts: {
        det: { verdict: 'approved' },
        llm: { verdict: 'approved' },
      },
    });
  }

  it('with reReviewAspectIds={det}: llm provider NOT called, llm verdict carried forward, det re-evaluated', async () => {
    const tmpDir = await setup('rereview-subset');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change — touch the det aspect's check.mjs (still passes).
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // No source change — upstream drift only.
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.pendingDriftState).toBeDefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      reReviewAspectIds: new Set(['det']),
    });

    expect(result.action).toBe('approved');
    // The LLM provider must NOT be called — only `det` was dispatched.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // `det` was re-evaluated this run.
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    // `llm` carried forward — committed verdict equals the prior baseline value.
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('with reReviewAspectIds=∅ (empty): NOTHING dispatched, full prior baseline preserved byte-for-byte', async () => {
    const tmpDir = await setup('rereview-empty');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change so approveNode still produces a pendingDriftState.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // No source change — upstream drift only.
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.pendingDriftState).toBeDefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      // Empty subset → filtered.length === 0 → reviewerAborted no-op path.
      reReviewAspectIds: new Set<string>(),
    });

    // Empty-subset no-op: no aspect dispatched at all.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // No reviewer landed a result — aspectResults stays absent/empty.
    expect(result.aspectResults).toBeUndefined();
    // The committed verdicts equal the FULL prior baseline, byte-for-byte: both
    // det and llm carried forward unchanged.
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed).toEqual({
      det: { verdict: 'approved' },
      llm: { verdict: 'approved' },
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('with reReviewAspectIds undefined: BOTH aspects dispatch (llm provider IS called)', async () => {
    const tmpDir = await setup('rereview-all');
    await recordBaselineWithVerdicts(tmpDir);
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      // reReviewAspectIds undefined → re-run all (today's behavior).
    });

    expect(result.action).toBe('approved');
    // The llm aspect IS dispatched → provider called exactly once.
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['llm']?.satisfied).toBe(true);
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('via runLlmVerification: an aspects/det/ upstream change attributes to det only — llm carried forward (yggPrefix threading)', async () => {
    const tmpDir = await setup('rereview-cli-layer');
    await recordBaselineWithVerdicts(tmpDir);
    // Upstream-only change under .yggdrasil/aspects/det/ — must attribute to `det`.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // CLI layer computes yggPrefix internally and threads reReviewAspectIds.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // Only `det` drifted (attributable to aspects/det/), so the llm provider is
    // never called — proving the internal yggPrefix matches the changedUpstream paths.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Option 1: end-to-end correctness invariants ──────────────
//
// These lock the composed behavior the unit tests (selectDriftedAspects,
// reReviewAspectIds dispatch) prove in isolation: a subset re-run must not
// weaken refusal (I4), a genuinely-changed aspect is never silently carried
// forward (I1), drafts are never dispatched (I3), the Phase-4 migration shape
// (an aspect yaml content change) re-runs only that aspect locally at zero LLM
// cost (cost win), and a genuine no-change run dispatches nothing while leaving
// the prior structureTouchedFiles byte-identical.

describe('runApproveWithReviewer — Option 1 end-to-end invariants', () => {
  // Node: structure aspect `det` + llm aspect `llm`. The llm aspect is wired so
  // we can make it refuse on demand by swapping the mock provider verdict.
  async function setupDetLlm(name: string, opts: { detRefuses?: boolean } = {}) {
    // The node maps a single FILE (not the directory). buildOwnFiles only
    // includes stat.isFile() mapping entries, so a file mapping makes
    // ctx.files non-empty. The refusing check below references ctx.files[0]
    // — a real file that IS in context — so the violation is a genuine
    // CODE violation, not a STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT infra error.
    const detCheck = opts.detRefuses
      ? `export function check(ctx) {
  const first = ctx.files[0];
  if (!first) throw new Error('det fixture invariant broken: ctx.files is empty (mapping must be a file, not a directory)');
  return [{ file: first.path, line: 1, message: 'structural violation' }];
}\n`
      : 'export function check(_ctx) { return []; }\n';
    const { tmpDir } = await createTmpProject(name, {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\nmapping:\n  - src/svc/index.ts\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: structure\n',
          files: { 'check.mjs': detCheck },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
      ],
    });
    return tmpDir;
  }

  async function recordVerdicts(
    tmpDir: string,
    aspectVerdicts: Record<string, { verdict: 'approved' | 'refused' }>,
    structureTouchedFiles?: Record<string, Record<string, string>>,
  ): Promise<void> {
    const graph = await loadGraph(tmpDir);
    const node = graph.nodes.get('svc/my-service')!;
    const projectRoot = path.dirname(graph.rootPath);
    // When structureTouchedFiles is part of the baseline, fold it into the
    // tracked-file set so the recorded canonical hash and fileHashes include the
    // synthetic `structure-touched:<id>` key — exactly as a real prior approve
    // would have recorded it. Otherwise approveNode (which collects WITH the
    // baseline) would see a fresh synthetic key and mis-classify a genuine
    // no-change as upstream drift.
    const baselineForCollect = structureTouchedFiles
      ? ({ hash: '', files: {}, structureTouchedFiles } as DriftNodeState)
      : undefined;
    const trackedFiles = collectTrackedFiles(node, graph, baselineForCollect);
    const { canonicalHash, fileHashes, fileMtimes } = await hashTrackedFiles(
      projectRoot, trackedFiles, undefined, [],
    );
    // Capture the production-computed log baseline by running approveNode once
    // against this fresh project (no baseline yet → 'initial' with a populated
    // pendingDriftState.state.log). Recording it here makes logChanged false on
    // the subsequent no-change approve, so approveNode takes the branch that
    // clones the full prior baseline (including structureTouchedFiles) rather
    // than the log-update branch that drops it.
    const initial = await approveNode(graph, 'svc/my-service');
    const log = initial.pendingDriftState?.state.log;
    await writeNodeDriftState(graph.rootPath, 'svc/my-service', {
      hash: canonicalHash,
      files: fileHashes,
      mtimes: fileMtimes,
      ...(log ? { log } : {}),
      aspectVerdicts,
      ...(structureTouchedFiles ? { structureTouchedFiles } : {}),
    });
  }

  // ── I4 — a genuine enforced CODE violation under a subset still refuses,
  //         records the refused verdict, and carries forward the other aspect ──
  it('I4: reReviewAspectIds={det} where det produces a genuine ENFORCED code violation → refused, det verdict persisted as refused, llm carried forward', async () => {
    // `det` (a structure aspect; default status enforced) maps a single FILE,
    // so ctx.files is non-empty and the check returns a violation against
    // ctx.files[0] — a real, in-context file. That makes it a genuine CODE
    // violation (errorSource: 'codeViolation'), NOT an infrastructure error.
    // We restrict dispatch to {det} only. The subset path must still refuse —
    // it must not weaken refusal — and the refused verdict is committed to the
    // baseline (the project records refused verdicts so yg check can render
    // them), while `llm` (not in the subset) is carried forward untouched.
    const tmpDir = await setupDetLlm('e2e-i4-refuse', { detRefuses: true });
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // Upstream-only change so approveNode produces a pendingDriftState w/o source edit.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/yg-aspect.yaml'),
      'name: Det\ndescription: structural shape (tweaked)\nreviewer:\n  type: structure\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedBefore = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry: storedBefore,
      reReviewAspectIds: new Set(['det']),
    });

    // The subset path must NOT weaken refusal: an enforced structure violation refuses.
    expect(result.action).toBe('refused');
    // det refuses with a GENUINE code violation — not an infra/astRuntime error.
    const detViolation = result.aspectViolations!.find(v => v.aspectId === 'det');
    expect(detViolation).toBeDefined();
    expect(detViolation!.errorSource).toBe('codeViolation');
    expect(detViolation!.reason).toContain('src/svc/index.ts');
    // The llm provider was never dispatched (only det in the subset).
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // The baseline IS written on the refusal path: det's refused verdict is
    // persisted (with its code-violation reason), and llm — not in the subset —
    // is carried forward from the prior baseline untouched.
    const storedAfter = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(storedAfter?.aspectVerdicts).toEqual({
      det: {
        verdict: 'refused',
        reason: 'src/svc/index.ts:1: structural violation',
        errorSource: 'codeViolation',
      },
      llm: { verdict: 'approved' },
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── I1 — a changed LLM aspect IS re-run (never silently carried forward) ──
  it('I1: an aspects/llm/ upstream change re-runs the llm aspect (provider called once), det carried forward', async () => {
    const tmpDir = await setupDetLlm('e2e-i1-llm-changed');
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // Upstream-only change under .yggdrasil/aspects/llm/ — must attribute to `llm`.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/llm/content.md'),
      'Code must be deterministic. (clarified)\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects runs for real and
    // computes reReviewAspectIds={llm} internally from result.changedUpstream.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // The genuinely-changed llm aspect IS dispatched — never silently carried forward.
    expect(verifyCallCount).toBe(1);
    expect(result.aspectResults?.['llm']?.satisfied).toBe(true);
    // The structure aspect `det` was NOT re-evaluated this run (carried forward).
    expect(result.aspectResults?.['det']).toBeUndefined();
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── I3 — draft aspect never dispatched, prior verdict preserved ──
  it('I3: a draft aspect is never dispatched and its prior verdict is left untouched', async () => {
    const { tmpDir } = await createTmpProject('e2e-i3-draft', {
      nodePath: 'svc/my-service',
      nodeYaml:
        'name: MyService\ntype: service\ndescription: test\naspects:\n  - det\n  - llm\n  - drafty\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [
        {
          id: 'det',
          yaml: 'name: Det\ndescription: structural shape\nreviewer:\n  type: structure\n',
          files: { 'check.mjs': 'export function check(_ctx) { return []; }\n' },
        },
        {
          id: 'llm',
          yaml: 'name: Llm\ndescription: must be deterministic\nreviewer:\n  type: llm\n',
          files: { 'content.md': 'Code must be deterministic.\n' },
        },
        {
          id: 'drafty',
          yaml: 'name: Drafty\ndescription: work in progress\nreviewer:\n  type: llm\nstatus: draft\n',
          files: { 'content.md': 'Some draft rule.\n' },
        },
      ],
    });
    // Prior baseline carries a verdict for the (now-draft) aspect too — it must
    // be left untouched, then evicted by the draft cleanup (not by a reviewer).
    const graph0 = await loadGraph(tmpDir);
    const node0 = graph0.nodes.get('svc/my-service')!;
    const trackedFiles0 = collectTrackedFiles(node0, graph0);
    const projectRoot0 = path.dirname(graph0.rootPath);
    const h0 = await hashTrackedFiles(projectRoot0, trackedFiles0, undefined, []);
    await writeNodeDriftState(graph0.rootPath, 'svc/my-service', {
      hash: h0.canonicalHash,
      files: h0.fileHashes,
      mtimes: h0.fileMtimes,
      aspectVerdicts: {
        det: { verdict: 'approved' },
        llm: { verdict: 'approved' },
        drafty: { verdict: 'approved' },
      },
    });
    // Upstream-only change under aspects/det/ so the subset is {det}.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/check.mjs'),
      'export function check(_ctx) { return []; /* tweaked */ }\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    expect(coreResult.changedSource).toBeUndefined();

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    const storedEntry = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
      storedEntry,
      reReviewAspectIds: new Set(['det']),
    });

    expect(result.action).toBe('approved');
    // The draft aspect was never dispatched to any reviewer.
    expect(result.aspectResults?.['drafty']).toBeUndefined();
    // The non-draft llm aspect was carried forward (subset = {det}), so the
    // provider was never called either.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    // The draft aspect was skipped — listed in skippedDraftAspects.
    expect(result.skippedDraftAspects).toContain('drafty');
    // The committed verdicts retain det+llm; the draft's stale verdict is evicted
    // by the draft-cleanup pass (no reviewer ever produced/changed it).
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Migration-shape payoff — the cost win ──────────────────
  it('migration shape: an aspects/det/yg-aspect.yaml content change re-runs det locally, llm NOT called', async () => {
    const tmpDir = await setupDetLlm('e2e-migration-win');
    await recordVerdicts(tmpDir, { det: { verdict: 'approved' }, llm: { verdict: 'approved' } });
    // Phase-4 migration shape: a change to the aspect's yg-aspect.yaml content.
    await writeFile(
      path.join(tmpDir, '.yggdrasil/aspects/det/yg-aspect.yaml'),
      'name: Det\ndescription: structural shape (migrated)\nreviewer:\n  type: structure\n',
    );

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // Confirm the migration shape: upstream-only, attributable to aspects/det/.
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.changedUpstream?.map(c => c.filePath)).toContain(
      '.yggdrasil/aspects/det/yg-aspect.yaml',
    );

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects runs end-to-end.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    expect(result.action).toBe('approved');
    // The concrete cost win: only `det` re-runs locally, the llm provider is
    // never constructed/called — ZERO LLM calls for an aspect-yaml migration.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults?.['det']?.satisfied).toBe(true);
    const committed = result.pendingDriftState?.state.aspectVerdicts;
    expect(committed?.['det']).toEqual({ verdict: 'approved' });
    expect(committed?.['llm']).toEqual({ verdict: 'approved' });
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── no-change → zero reviewer calls AND structureTouchedFiles preserved ──
  it('no-change: zero reviewer calls and structureTouchedFiles preserved byte-identical', async () => {
    const PRIOR_STF = { det: { 'src/svc/index.ts': 'deadbeef'.repeat(8) } };
    const tmpDir = await setupDetLlm('e2e-no-change-stf');
    // Record a baseline WITH structureTouchedFiles and both verdicts approved.
    await recordVerdicts(
      tmpDir,
      { det: { verdict: 'approved' }, llm: { verdict: 'approved' } },
      PRIOR_STF,
    );
    // No source edit, no upstream edit → genuine no-change.

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    // Genuine no-change: neither source nor upstream drifted.
    expect(coreResult.action).toBe('no-change');
    expect(coreResult.changedSource).toBeUndefined();
    expect(coreResult.changedUpstream).toBeUndefined();
    // approveNode clones the prior baseline into pendingDriftState for no-change.
    expect(coreResult.pendingDriftState?.state.structureTouchedFiles).toEqual(PRIOR_STF);

    let verifyCallCount = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCallCount++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));

    // Drive through runLlmVerification so selectDriftedAspects returns ∅ for real
    // (no changedSource, no changedUpstream) → no dispatch path.
    const result = await runLlmVerification(graph, 'svc/my-service', coreResult, new Map());

    // No aspect dispatched at all — neither the structure runner nor the provider.
    expect(verifyCallCount).toBe(0);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(result.aspectResults).toBeUndefined();
    // The no-dispatch path must NOT wipe structureTouchedFiles — it is byte-identical.
    expect(result.pendingDriftState?.state.structureTouchedFiles).toEqual(PRIOR_STF);
    // And the committed verdicts equal the full prior baseline.
    expect(result.pendingDriftState?.state.aspectVerdicts).toEqual({
      det: { verdict: 'approved' },
      llm: { verdict: 'approved' },
    });
    // The on-disk baseline retains the prior structureTouchedFiles too.
    const stored = await readNodeDriftState(graph.rootPath, 'svc/my-service');
    expect(stored?.structureTouchedFiles).toEqual(PRIOR_STF);
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── resolveExecutionPlan unit tests ──────────────────────────

function makeAspect(id: string, type: 'llm' | 'ast', tier?: string): AspectDef {
  return {
    id,
    name: id,
    reviewer: tier ? { type, tier } : { type },
    artifacts: [],
  } as unknown as AspectDef;
}

function makeReviewer(tiers: Record<string, object>, defaultTier?: string): ReviewerConfig {
  return {
    tiers: tiers as ReviewerConfig['tiers'],
    default: defaultTier,
  };
}

describe('resolveExecutionPlan', () => {
  it('assigns AST aspects to ast kind', () => {
    const aspects = [makeAspect('check-syntax', 'ast')];
    const reviewer = makeReviewer({ fast: { provider: 'ollama', consensus: 1, config: { model: 'llama3' } } });
    const { resolved, errors } = resolveExecutionPlan(aspects, reviewer);
    expect(errors).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe('ast');
  });

  it('assigns LLM aspects to llm kind with single tier as default', () => {
    const aspects = [makeAspect('deterministic', 'llm')];
    const reviewer = makeReviewer({ fast: { provider: 'ollama', consensus: 1, config: { model: 'llama3' } } });
    const { resolved, errors } = resolveExecutionPlan(aspects, reviewer);
    expect(errors).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe('llm');
    if (resolved[0].kind === 'llm') {
      expect(resolved[0].tierName).toBe('fast');
    }
  });

  it('assigns LLM aspect to named tier when reviewer.tier is set', () => {
    const aspects = [makeAspect('strict-check', 'llm', 'thorough')];
    const reviewer = makeReviewer({
      fast: { provider: 'ollama', consensus: 1, config: { model: 'llama3' } },
      thorough: { provider: 'ollama', consensus: 3, config: { model: 'llama3' } },
    }, 'fast');
    const { resolved, errors } = resolveExecutionPlan(aspects, reviewer);
    expect(errors).toHaveLength(0);
    expect(resolved[0].kind).toBe('llm');
    if (resolved[0].kind === 'llm') {
      expect(resolved[0].tierName).toBe('thorough');
    }
  });

  it('records error for LLM aspect referencing unknown tier', () => {
    const aspects = [makeAspect('needs-tier', 'llm', 'nonexistent')];
    const reviewer = makeReviewer({ fast: { provider: 'ollama', consensus: 1, config: { model: 'llama3' } } });
    const { resolved, errors } = resolveExecutionPlan(aspects, reviewer);
    expect(resolved).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].what).toContain('nonexistent');
  });

  it('mixes AST and LLM aspects without errors', () => {
    const aspects = [makeAspect('check-syntax', 'ast'), makeAspect('deterministic', 'llm')];
    const reviewer = makeReviewer({ fast: { provider: 'ollama', consensus: 1, config: { model: 'llama3' } } });
    const { resolved, errors } = resolveExecutionPlan(aspects, reviewer);
    expect(errors).toHaveLength(0);
    expect(resolved).toHaveLength(2);
    expect(resolved.filter(r => r.kind === 'ast')).toHaveLength(1);
    expect(resolved.filter(r => r.kind === 'llm')).toHaveLength(1);
  });
});

describe('runApproveWithReviewer — AST aspects', () => {
  const AST_ASPECT_YAML = 'name: NoConsole\ndescription: No console.log\nreviewer:\n  type: ast\nlanguage:\n  - typescript\n';

  it('commits when AST-only aspect finds no violations (no reviewer configured)', async () => {
    const { tmpDir } = await createTmpProject('ast-pass', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-console\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'no-console',
        yaml: AST_ASPECT_YAML,
        files: { 'check.mjs': 'export function check(ctx) { return []; }' },
      }],
      configYaml: 'quality:\n  max_direct_relations: 10\n',  // no reviewer section
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

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
    expect(result.aspectResults?.['no-console']?.satisfied).toBe(true);
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses when AST aspect finds violations', async () => {
    const { tmpDir } = await createTmpProject('ast-fail', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-console\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'no-console',
        yaml: AST_ASPECT_YAML,
        files: {
          'check.mjs': `export function check(ctx) {
  if (ctx.files.length === 0) return [];
  return [{ file: ctx.files[0].path, line: 1, message: 'always fails' }];
}`,
        },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

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
    expect(result.aspectViolations?.length).toBeGreaterThan(0);
    expect(result.aspectViolations![0].errorSource).toBe('codeViolation');
    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('runApproveWithReviewer — AST error paths', () => {
  const AST_ASPECT_YAML = 'name: NoConsole\ndescription: No console.log\nreviewer:\n  type: ast\nlanguage:\n  - typescript\n';

  it('refuses with astRuntime error when check.mjs throws', async () => {
    const { tmpDir } = await createTmpProject('ast-throw', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - no-console\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'no-console',
        yaml: AST_ASPECT_YAML,
        files: { 'check.mjs': 'export function check(ctx) { throw new Error("check script failed"); }' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

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
    expect(result.aspectViolations?.[0].errorSource).toBe('astRuntime');
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('runApproveWithReviewer — additional coverage', () => {
  it('skips LLM and commits when provider is not available', async () => {
    const { tmpDir } = await createTmpProject('reviewer-provider-unavail', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: ASPECT_YAML,
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

    const graph = await loadGraph(tmpDir);
    const coreResult = await approveNode(graph, 'svc/my-service');
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({ isAvailable: async () => false }));

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc/my-service',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });
    expect(result.llmSkipped).toBe('unavailable');
    expect(result.action).toBe('approved');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses with plan error when aspect references unknown tier', async () => {
    const { tmpDir } = await createTmpProject('reviewer-tier-error', {
      nodePath: 'svc/my-service',
      nodeYaml: 'name: MyService\ntype: service\ndescription: test\naspects:\n  - deterministic\nmapping:\n  - src/svc/\n',
      mappingFiles: { 'src/svc/index.ts': 'const x = 1;\n' },
      aspects: [{
        id: 'deterministic',
        yaml: 'name: Deterministic\ndescription: Pure transforms only\nreviewer:\n  type: llm\n  tier: nonexistent\n',
        files: { 'content.md': 'Code must be deterministic.\n' },
      }],
    });
    await recordBaseline(tmpDir);
    await writeFile(path.join(tmpDir, 'src/svc/index.ts'), 'const x = 2;\n');

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
    expect(result.refuseReasonData?.what).toContain('Tier resolution failed');
    await rm(tmpDir, { recursive: true, force: true });
  });
});
