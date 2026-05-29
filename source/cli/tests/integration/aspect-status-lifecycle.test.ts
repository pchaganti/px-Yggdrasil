import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode } from '../../src/core/approve.js';
import { runApproveWithReviewer } from '../../src/core/approve-reviewer.js';
import { runCheck } from '../../src/core/check.js';
import type { LlmProvider } from '../../src/llm/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');
const SCHEMAS_SRC = join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

vi.mock('../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../src/llm/index.js';
const mockCreate = vi.mocked(createLlmProvider);

function makeApproveProvider(): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    getContextWindowSize: async () => 8192,
  };
}

function makeRefuseProvider(): LlmProvider {
  return {
    verifyAspect: async () => ({
      satisfied: false,
      reason: 'reviewer says no',
      errorSource: 'codeViolation' as const,
    }),
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

function ygCheck(repo: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, 'check'], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

async function runCheckInProcess(repo: string) {
  const graph = await loadGraph(repo);
  return runCheck(graph, null);
}

function writeAspect(repo: string, status: 'draft' | 'advisory' | 'enforced'): void {
  writeFileSync(
    join(repo, '.yggdrasil', 'aspects', 'a', 'yg-aspect.yaml'),
    `name: A
description: t
reviewer:
  type: llm
status: ${status}
`,
    'utf-8',
  );
}

function buildRepo(initialStatus: 'draft' | 'advisory' | 'enforced'): string {
  const repo = mkdtempSync(join(tmpdir(), 'yg-status-lifecycle-'));
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
  writeAspect(repo, initialStatus);
  writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
  writeFileSync(
    join(ygg, 'model', 'svc', 'yg-node.yaml'),
    `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
`,
    'utf-8',
  );
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

describe('integration — aspect status lifecycle (draft → advisory → enforced)', () => {
  const repos: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('stage 1 — draft aspect: yg check exits 0 with no baseline (dormant)', async () => {
    const repo = buildRepo('draft');
    repos.push(repo);

    // No approve needed. Source file exists, aspect is draft, so no drift tracking.
    const { code, out } = ygCheck(repo);
    expect(code).toBe(0);
    // Drift state file must NOT exist — draft aspects are dormant.
    expect(existsSync(join(repo, '.yggdrasil', '.drift-state', 'svc.json'))).toBe(false);
    // No newly-active / unapproved emission for the draft node.
    expect(out).not.toContain('aspect-newly-active');
    expect(out).not.toContain('unapproved');
  });

  it('stage 2 — flip draft → advisory: yg check reports unapproved (no baseline)', async () => {
    const repo = buildRepo('draft');
    repos.push(repo);

    // Confirm baseline state: no errors.
    expect(ygCheck(repo).code).toBe(0);

    // Promote to advisory — node now has a non-draft effective aspect but
    // no baseline → "unapproved" lifecycle error.
    writeAspect(repo, 'advisory');
    const { code, out } = ygCheck(repo);
    expect(code).toBe(1);
    expect(out).toContain('svc');
    // Per check.ts: missing baseline with non-draft aspect → 'unapproved' code.
    expect(out).toMatch(/unapproved|aspect-newly-active/);
  });

  it('stage 3 — approve at advisory: yg check exits 0', async () => {
    mockCreate.mockReturnValue(makeApproveProvider());
    const repo = buildRepo('advisory');
    repos.push(repo);

    await approveSvc(repo);

    const { code, out } = ygCheck(repo);
    expect(code).toBe(0);
    expect(out).not.toContain('aspect-newly-active');
    expect(out).not.toContain('aspect-violation-enforced');
  });

  it('stage 4 — refused at advisory: yg check renders warning (exit 0)', async () => {
    mockCreate.mockReturnValue(makeRefuseProvider());
    const repo = buildRepo('advisory');
    repos.push(repo);

    // Approve at advisory with refused verdict — baseline records refused.
    await approveSvc(repo);

    const { code, out } = ygCheck(repo);
    // Advisory refused → warning, not error → exit 0.
    expect(code).toBe(0);
    // New format: advisory label in warning block, not code string in header.
    expect(out).toContain('advisory');
    // New format: verdict line starts with 'yg check: PASS (N warnings)'.
    expect(out).toContain('yg check: PASS');
    expect(out).toContain('Warnings (1)');

    // In-process check: verify exact issue codes.
    const result = await runCheckInProcess(repo);
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain('aspect-violation-advisory');
    expect(codes).not.toContain('aspect-violation-enforced');
  });

  it('stage 5 — promote advisory → enforced with refused baseline: yg check renders error (exit 1)', async () => {
    mockCreate.mockReturnValue(makeRefuseProvider());
    const repo = buildRepo('advisory');
    repos.push(repo);

    // Approve at advisory with refused verdict (baseline now refused).
    await approveSvc(repo);

    // Promote the aspect default to enforced. The aspect yaml file bytes
    // change → upstream cascade drift would mask the verdict-classification
    // change. Re-approve to clear the cascade (the mock provider still
    // refuses, so the refused verdict is preserved). Only the effective
    // classification (advisory → enforced) changes.
    await writeFile(
      join(repo, '.yggdrasil', 'aspects', 'a', 'yg-aspect.yaml'),
      `name: A
description: t
reviewer:
  type: llm
status: enforced
`,
      'utf-8',
    );
    await approveSvc(repo);

    // CLI exit is 1, but the aspect-violation-enforced code is not rendered
    // in any category section (uncategorized in cli/check.ts). Confirm at
    // the issue level via runCheck.
    expect(ygCheck(repo).code).toBe(1);

    const result = await runCheckInProcess(repo);
    const codes = result.issues.filter(i => i.severity === 'error').map(i => i.code);
    expect(codes).toContain('aspect-violation-enforced');
    expect(codes).not.toContain('aspect-violation-advisory');
  });

  it('stage 6 — demote enforced → draft: drift state cleared (no baseline retained)', async () => {
    mockCreate.mockReturnValue(makeApproveProvider());
    const repo = buildRepo('enforced');
    repos.push(repo);

    await approveSvc(repo);
    // Sanity: drift state exists after approve.
    expect(existsSync(join(repo, '.yggdrasil', '.drift-state', 'svc.json'))).toBe(true);

    // Demote to draft — node now has only-draft effective aspects.
    writeAspect(repo, 'draft');

    // Re-approve to trigger the GC path (commitApprovalAndCleanDrafts).
    await approveSvc(repo);

    // Per design (and consistent with aspect-status-hash-stability test):
    // the per-node drift state file is GC'd when the node has no non-draft
    // effective aspects.
    expect(existsSync(join(repo, '.yggdrasil', '.drift-state', 'svc.json'))).toBe(false);

    // And `yg check` is clean.
    const { code } = ygCheck(repo);
    expect(code).toBe(0);
  });
});
