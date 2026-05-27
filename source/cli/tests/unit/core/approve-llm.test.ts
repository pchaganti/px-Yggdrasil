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
    expect(result.action).toBe('approved');
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
