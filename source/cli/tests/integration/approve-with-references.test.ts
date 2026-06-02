import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
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

function captureProvider(captured: string[]): LlmProvider {
  return {
    verifyAspect: vi.fn(async (prompt: string) => {
      captured.push(prompt);
      return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
    }),
    isAvailable: async () => true,
  } as unknown as LlmProvider;
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

describe('integration — approve with references captured in prompt', () => {
  const repos: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('captured prompt contains XML-escaped references block', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-refs-prompt-'));
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
    // Reference file content contains XML-special characters
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1 & CODE_2\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');
    // Description also contains XML-special characters
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - path: docs/codes.md
    description: "<bad> & \\"broken\\""
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

    const captured: string[] = [];
    mockCreate.mockReturnValue(captureProvider(captured));

    const graph = await loadGraph(repo);
    const coreResult = await approveNode(graph, 'svc');
    await runApproveWithReviewer({
      graph,
      nodePath: 'svc',
      result: coreResult,
      rootPath: graph.rootPath,
      secretsByProvider: new Map(),
    });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured[0]!;

    // References block is present
    expect(prompt).toContain('<references>');
    expect(prompt).toContain('</references>');

    // Description attribute is XML-escaped
    expect(prompt).toContain('description="&lt;bad&gt; &amp; &quot;broken&quot;"');

    // Body content is XML-escaped (& → &amp;)
    expect(prompt).toContain('CODE_1 &amp; CODE_2');
  });
});
