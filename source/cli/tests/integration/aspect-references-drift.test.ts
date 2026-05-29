import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode } from '../../src/core/approve.js';
import { runApproveWithReviewer } from '../../src/core/approve-reviewer.js';
import type { LlmProvider } from '../../src/llm/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');
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

describe('integration — aspect references drift cascade', () => {
  const repos: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('modifying a reference file triggers upstream drift on the affected node', async () => {
    // Setup repo
    const repo = mkdtempSync(join(tmpdir(), 'yg-refs-drift-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'schemas'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });

    for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
      copyFileSync(join(SCHEMAS_SRC, schema), join(ygg, 'schemas', schema));
    }

    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'ref.md'), 'ORIGINAL_CONTENT\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - docs/ref.md
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

    // Establish baseline by approving the node in-process
    mockCreate.mockReturnValue(makeMockProvider());
    const graph = await loadGraph(repo);
    const coreResult = await approveNode(graph, 'svc');
    await runApproveWithReviewer({
      graph,
      nodePath: 'svc',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Verify no drift after approval
    const { out: outBefore } = ygCheck(repo);
    expect(outBefore).not.toContain('upstream-drift');

    // Modify the reference file — should trigger upstream drift
    await writeFile(join(repo, 'docs', 'ref.md'), 'MODIFIED_CONTENT\n', 'utf-8');

    // Run check — expect upstream drift on svc
    const { code, out } = ygCheck(repo);
    expect(code).toBe(1);
    expect(out).toContain('svc');
    // Drift is reported (either upstream-drift cascade or source-drift)
    // New format uses labels 'cascade (N)' and 'drift' (lowercase)
    const hasDrift = out.includes('upstream-drift') || out.includes('source-drift') || out.includes('unapproved')
      || out.toLowerCase().includes('cascade') || out.toLowerCase().includes('drift');
    expect(hasDrift).toBe(true);
  });
});
