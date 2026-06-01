import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { recordBaselineForAllMappedNodes } from '../unit/helpers/seed-baseline.js';
import { approveNode, commitApproval } from '../../src/core/approve.js';
import { runApproveWithReviewer } from '../../src/core/approve-reviewer.js';
import { runCheck } from '../../src/core/check.js';
import { writeNodeDriftState } from '../../src/io/drift-state-store.js';
import { hashTrackedFiles } from '../../src/io/hash.js';
import { collectTrackedFiles } from '../../src/core/graph/files.js';
import { DRIFT_STATE_SCHEMA_VERSION } from '../../src/model/drift.js';
import type { LlmProvider } from '../../src/llm/types.js';
import type { LlmConfig } from '../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../fixtures/multi-tier-repo');

vi.mock('../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../src/llm/index.js';
const mockCreate = vi.mocked(createLlmProvider);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
    ...overrides,
  };
}

async function setupRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-multi-tier-'));
  await cp(FIXTURE, root, { recursive: true });
  return root;
}

async function recordBaseline(root: string): Promise<void> {
  const graph = await loadGraph(root);
  await recordBaselineForAllMappedNodes(graph);
}

describe('multi-tier approve', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    for (const p of cleanup.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });

  it('LLM aspects routed to expected tiers — createLlmProvider called once per tier', async () => {
    const root = await setupRepo();
    cleanup.push(root);
    await recordBaseline(root);

    // Touch payments.ts to trigger drift
    await writeFile(path.join(root, 'src', 'payments.ts'), 'export const x = 2;\n');

    const graph = await loadGraph(root);
    const coreResult = await approveNode(graph, 'payments');

    // Capture which LlmConfig each provider was constructed with
    const capturedConfigs: LlmConfig[] = [];
    mockCreate.mockImplementation((cfg: LlmConfig) => {
      capturedConfigs.push(cfg);
      return makeMockProvider();
    });

    await runApproveWithReviewer({
      graph,
      nodePath: 'payments',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // payments has requires-logging (standard) + requires-audit (deep) → 2 provider creations
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const models = capturedConfigs.map(c => c.model).sort();
    expect(models).toContain('sonnet'); // standard tier
    expect(models).toContain('opus');   // deep tier

    const consensuses = capturedConfigs.map(c => c.consensus).sort();
    expect(consensuses).toContain(1);   // standard: consensus 1
    expect(consensuses).toContain(3);   // deep: consensus 3
  });

  it('AST aspect bypasses LLM provider — no createLlmProvider call for AST-only node', async () => {
    const root = await setupRepo();
    cleanup.push(root);

    // Create a node with only an AST aspect
    const yggRoot = path.join(root, '.yggdrasil');
    await (await import('node:fs/promises')).mkdir(path.join(yggRoot, 'model', 'worker'), { recursive: true });
    await writeFile(
      path.join(yggRoot, 'model', 'worker', 'yg-node.yaml'),
      'name: worker\ntype: service\ndescription: AST-only node\naspects:\n  - no-sync-io\nmapping:\n  - src/worker.ts\n',
    );
    await writeFile(path.join(root, 'src', 'worker.ts'), 'export const work = () => {};\n');

    const graph = await loadGraph(root);
    const coreResult = await approveNode(graph, 'worker');

    mockCreate.mockReturnValue(makeMockProvider());

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'worker',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(result.action).toBe('initial');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('post-approve, drift-state baseline exists for each node', async () => {
    const root = await setupRepo();
    cleanup.push(root);

    mockCreate.mockReturnValue(makeMockProvider());

    const graph = await loadGraph(root);

    for (const nodePath of ['api', 'payments']) {
      const coreResult = await approveNode(graph, nodePath);
      const reviewed = await runApproveWithReviewer({
        graph,
        nodePath,
        result: coreResult,
        rootPath: graph.rootPath,
        secretsByProvider: new Map(),
      });
      await commitApproval(graph.rootPath, reviewed);
    }

    // Both nodes should have drift state after approval
    const { readNodeDriftState } = await import('../../src/io/drift-state-store.js');
    const apiState = await readNodeDriftState(graph.rootPath, 'api');
    const paymentsState = await readNodeDriftState(graph.rootPath, 'payments');

    expect(apiState).toBeDefined();
    expect(paymentsState).toBeDefined();
    expect(apiState!.hash.length).toBeGreaterThan(8);
    expect(paymentsState!.hash.length).toBeGreaterThan(8);
  });

  it('changing aspect.tier triggers drift on that node', async () => {
    const root = await setupRepo();
    cleanup.push(root);

    mockCreate.mockReturnValue(makeMockProvider());

    // Establish baseline
    await recordBaseline(root);

    // Verify no drift initially
    const graph1 = await loadGraph(root);
    const check1 = await runCheck(graph1, null);
    const driftBefore = check1.issues.filter(i => i.code === 'upstream-drift' && i.nodePath === 'payments');
    expect(driftBefore).toHaveLength(0);

    // Change requires-audit from tier: deep → tier: standard
    const aspectYaml = path.join(root, '.yggdrasil', 'aspects', 'requires-audit', 'yg-aspect.yaml');
    await writeFile(aspectYaml,
      'name: Requires Audit\ndescription: "Every mutation must emit an audit event"\nreviewer:\n  type: llm\n  tier: standard\n',
    );

    const graph2 = await loadGraph(root);
    const check2 = await runCheck(graph2, null);
    const driftAfter = check2.issues.filter(i => i.code === 'upstream-drift' && i.nodePath === 'payments');
    expect(driftAfter.length).toBeGreaterThan(0);
  });

  it('renaming a tier in config triggers drift on all nodes using that tier', async () => {
    const root = await setupRepo();
    cleanup.push(root);

    // Establish baseline
    await recordBaseline(root);

    const graph1 = await loadGraph(root);
    const check1 = await runCheck(graph1, null);
    const initialDrift = check1.issues.filter(
      i => i.code === 'upstream-drift' && (i.nodePath === 'api' || i.nodePath === 'payments'),
    );
    expect(initialDrift).toHaveLength(0);

    // Rename 'standard' tier → 'normal' in config
    const configPath = path.join(root, '.yggdrasil', 'yg-config.yaml');
    const cfg = await readFile(configPath, 'utf-8');
    await writeFile(configPath, cfg.replace('standard:', 'normal:').replace('default: standard', 'default: normal'));

    const graph2 = await loadGraph(root);
    const check2 = await runCheck(graph2, null);
    const afterDrift = check2.issues.filter(
      i => i.code === 'upstream-drift' && (i.nodePath === 'api' || i.nodePath === 'payments'),
    );
    // Both nodes use the standard tier (directly or as default) → both drift
    expect(afterDrift.length).toBeGreaterThan(0);
  });

  it('rotating api_key in yg-secrets.yaml does NOT trigger drift', async () => {
    const root = await setupRepo();
    cleanup.push(root);

    // Establish baseline
    await recordBaseline(root);

    // Write (or overwrite) secrets file
    const secretsPath = path.join(root, '.yggdrasil', 'yg-secrets.yaml');
    await writeFile(secretsPath,
      'reviewer:\n  ollama:\n    api_key: original-key\n',
    );

    const graph1 = await loadGraph(root);
    const check1 = await runCheck(graph1, null);
    const driftAfterCreate = check1.issues.filter(
      i => i.code === 'upstream-drift' && (i.nodePath === 'api' || i.nodePath === 'payments'),
    );
    expect(driftAfterCreate).toHaveLength(0);

    // Rotate the key
    await writeFile(secretsPath,
      'reviewer:\n  ollama:\n    api_key: rotated-key\n',
    );

    const graph2 = await loadGraph(root);
    const check2 = await runCheck(graph2, null);
    const driftAfterRotate = check2.issues.filter(
      i => i.code === 'upstream-drift' && (i.nodePath === 'api' || i.nodePath === 'payments'),
    );
    expect(driftAfterRotate).toHaveLength(0);
  });
});
