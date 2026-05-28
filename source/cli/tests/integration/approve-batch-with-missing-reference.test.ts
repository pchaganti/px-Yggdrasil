import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../src/core/graph-loader.js';
import { approveNode } from '../../src/core/approve.js';
import { runApproveWithReviewer } from '../../src/core/approve-reviewer.js';
import type { LlmProvider } from '../../src/llm/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS_SRC = join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

vi.mock('../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

import { createLlmProvider } from '../../src/llm/index.js';
const mockCreate = vi.mocked(createLlmProvider);

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

describe('integration — batch approve failure isolation for missing reference', () => {
  const repos: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('aspect with missing reference fails in isolation; other aspects in same batch still run', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-refs-batch-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'schemas'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'b'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'c'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });

    for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
      copyFileSync(join(SCHEMAS_SRC, schema), join(ygg, 'schemas', schema));
    }

    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    // Create the reference file initially so yg check and loadGraph pass validation
    const missingRefPath = join(repo, 'docs', 'MISSING.md');
    writeFileSync(missingRefPath, 'TEMP\n', 'utf-8');

    writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');

    // Aspect A declares a reference to docs/MISSING.md
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: aspect A
reviewer: { type: llm }
references:
  - docs/MISSING.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');

    // Aspects B and C have no references
    writeFileSync(join(ygg, 'aspects', 'b', 'yg-aspect.yaml'), `name: B
description: aspect B
reviewer: { type: llm }
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'content.md'), '# B\n', 'utf-8');

    writeFileSync(join(ygg, 'aspects', 'c', 'yg-aspect.yaml'), `name: C
description: aspect C
reviewer: { type: llm }
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'c', 'content.md'), '# C\n', 'utf-8');

    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
  - b
  - c
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');

    // Load the graph while the reference file exists (passes validation)
    const graph = await loadGraph(repo);
    const coreResult = await approveNode(graph, 'svc');

    // Now DELETE the reference file to force runtime failure in the reference loader
    unlinkSync(missingRefPath);

    // Spy provider records which aspect prompts are verified
    const verifiedAspectIds: string[] = [];
    const spyProvider: LlmProvider = {
      verifyAspect: vi.fn(async (prompt: string) => {
        // Extract aspect id from prompt: <aspect id="<id>"
        const match = prompt.match(/<aspect id="([^"]+)"/);
        if (match) verifiedAspectIds.push(match[1]!);
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      }),
      isAvailable: async () => true,
      getContextWindowSize: async () => 8192,
    };
    mockCreate.mockReturnValue(spyProvider);

    const result = await runApproveWithReviewer({
      graph,
      nodePath: 'svc',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    // Aspect A should fail due to missing reference
    expect(result.aspectResults?.['a']?.satisfied).toBe(false);
    expect(result.aspectResults?.['a']?.reason).toContain('LLM_REFERENCE_UNREADABLE');

    // Aspects B and C should still have been verified (spy was called for them)
    expect(verifiedAspectIds).toContain('b');
    expect(verifiedAspectIds).toContain('c');

    // B and C should be satisfied (spy returns satisfied: true)
    expect(result.aspectResults?.['b']?.satisfied).toBe(true);
    expect(result.aspectResults?.['c']?.satisfied).toBe(true);

    // The user-facing refuseReasonData must use the distinct reference-failure message,
    // not the generic provider/infrastructure error message.
    expect(result.refuseReasonData?.what).toContain('Reference file load failed');
    expect(result.refuseReasonData?.what).toContain('a');
    expect(result.refuseReasonData?.what).not.toContain('provider connection');
  });
});
