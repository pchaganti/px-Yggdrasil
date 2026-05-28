import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode } from '../../src/core/approve.js';
import { runApproveWithReviewer } from '../../src/core/approve-reviewer.js';
import type { LlmProvider } from '../../src/llm/types.js';
import type { DriftNodeState } from '../../src/model/drift.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS_SRC = join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

vi.mock('../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../src/llm/index.js';
const mockCreate = vi.mocked(createLlmProvider);

function makeMockProvider(): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
  };
}

const YG_CONFIG = `
version: "5.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`;

/**
 * Build a tmp repo with one node (svc) holding a single LLM aspect `a` at the
 * given aspect-level status. Returns the repo path.
 */
function buildRepo(status: 'draft' | 'advisory' | 'enforced'): string {
  const repo = mkdtempSync(join(tmpdir(), 'yg-status-hash-'));
  const ygg = join(repo, '.yggdrasil');
  mkdirSync(join(ygg, 'schemas'), { recursive: true });
  mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
  mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(join(SCHEMAS_SRC, schema), join(ygg, 'schemas', schema));
  }

  writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');
  writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer:
  type: llm
status: ${status}
`, 'utf-8');
  writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
  writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
  writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');
  return repo;
}

async function approveSvc(repo: string): Promise<void> {
  const graph = await loadGraph(repo);
  const coreResult = await approveNode(graph, 'svc');
  await runApproveWithReviewer({
    graph,
    nodePath: 'svc',
    result: coreResult,
    rootPath: graph.rootPath,
    secretsByProvider: new Map(),
  });
}

function readDriftStateForSvc(repo: string): DriftNodeState | undefined {
  const p = join(repo, '.yggdrasil', '.drift-state', 'svc.json');
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf-8')) as DriftNodeState;
}

async function setAspectStatus(
  repo: string,
  status: 'draft' | 'advisory' | 'enforced',
): Promise<void> {
  const p = join(repo, '.yggdrasil', 'aspects', 'a', 'yg-aspect.yaml');
  await writeFile(p, `name: A
description: t
reviewer:
  type: llm
status: ${status}
`, 'utf-8');
}

describe('integration — aspect status hash stability', () => {
  const repos: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('tier-identity synthetic hash is unchanged when status flips advisory → enforced', async () => {
    mockCreate.mockReturnValue(makeMockProvider());

    // 1. Approve at advisory; record tier-identity hash.
    const repo = buildRepo('advisory');
    repos.push(repo);
    await approveSvc(repo);

    const beforeState = readDriftStateForSvc(repo);
    expect(beforeState).toBeDefined();
    const tierKey = 'tier-identity:a';
    const hashBefore = beforeState!.files[tierKey];
    expect(hashBefore).toBeDefined();
    expect(typeof hashBefore).toBe('string');
    expect(hashBefore.length).toBeGreaterThan(0);

    // 2. Flip status advisory → enforced and re-approve.
    //    The yg-aspect.yaml file bytes change, but the resolved tier config
    //    (which feeds canonicalTierJson) does NOT depend on status.
    await setAspectStatus(repo, 'enforced');
    await approveSvc(repo);

    const afterState = readDriftStateForSvc(repo);
    expect(afterState).toBeDefined();
    const hashAfter = afterState!.files[tierKey];
    expect(hashAfter).toBeDefined();
    // Invariant: tier-identity hash stable across status flip.
    expect(hashAfter).toBe(hashBefore);
  });

  it('tier-identity synthetic hash is unchanged when status flips enforced → advisory', async () => {
    mockCreate.mockReturnValue(makeMockProvider());

    const repo = buildRepo('enforced');
    repos.push(repo);
    await approveSvc(repo);

    const beforeState = readDriftStateForSvc(repo);
    const tierKey = 'tier-identity:a';
    const hashBefore = beforeState!.files[tierKey];
    expect(hashBefore).toBeDefined();

    await setAspectStatus(repo, 'advisory');
    await approveSvc(repo);

    const afterState = readDriftStateForSvc(repo);
    const hashAfter = afterState!.files[tierKey];
    expect(hashAfter).toBe(hashBefore);
  });

  it('node-level GC removes drift state when the only aspect goes enforced → draft', async () => {
    // When the node has only one aspect and that aspect flips to `draft`,
    // hasNonDraftEffectiveAspects returns false. The approve path skips
    // tracked-file hashing entirely, and the post-approve GC removes the
    // per-node drift state file. This documents the design: no
    // tier-identity entry survives once the node has no reviewer work.
    // Hash-stability invariant is vacuously satisfied — there is no hash
    // to compare against because the baseline itself is gone.
    mockCreate.mockReturnValue(makeMockProvider());

    const repo = buildRepo('enforced');
    repos.push(repo);
    await approveSvc(repo);

    const beforeState = readDriftStateForSvc(repo);
    expect(beforeState!.files['tier-identity:a']).toBeDefined();

    await setAspectStatus(repo, 'draft');
    await approveSvc(repo);

    // Per design: node-level GC removes the drift state file entirely
    // when the node has no non-draft effective aspects. No tier-identity
    // entry remains because there is no baseline to hold one.
    const afterState = readDriftStateForSvc(repo);
    expect(afterState).toBeUndefined();
  });
});
