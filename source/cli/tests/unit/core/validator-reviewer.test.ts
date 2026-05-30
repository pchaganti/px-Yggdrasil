import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../src/core/validator.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-vr-'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

function createAspect(id: string, reviewer?: AspectDef['reviewer'] | 'llm' | 'deterministic'): AspectDef {
  const reviewerSpec: AspectDef['reviewer'] =
    reviewer === undefined ? { type: 'llm' } :
    typeof reviewer === 'string' ? { type: reviewer as 'llm' | 'deterministic' } :
    reviewer;
  return {
    name: id,
    id,
    description: `Test aspect ${id}`,
    artifacts: [],
    reviewer: reviewerSpec,
  };
}

function createGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
    ...overrides,
  };
}

describe('aspect parse errors (Task 36)', () => {
  it('emits aspectParseErrors as structured validator codes', async () => {
    const graph = createGraph({
      aspectParseErrors: [
        {
          aspectId: 'bad-aspect',
          code: 'aspect-parse-error',
          messageData: {
            what: 'Failed to parse aspect bad-aspect',
            why: 'Invalid YAML',
            next: 'Fix the YAML syntax',
          },
        },
      ],
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-parse-error');

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(msgOf(issues[0])).toContain('Failed to parse aspect bad-aspect');
  });

  it('emits no aspect-parse-error issues when aspectParseErrors is empty', async () => {
    const graph = createGraph({ aspectParseErrors: [] });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-parse-error');

    expect(issues).toHaveLength(0);
  });

  it('emits no aspect-parse-error issues when aspectParseErrors is undefined', async () => {
    const graph = createGraph();

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-parse-error');

    expect(issues).toHaveLength(0);
  });
});

describe('config-reviewer-missing (Task 36b)', () => {
  it('emits config-reviewer-missing when config has no reviewer section', async () => {
    const graph = createGraph({ config: {} });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'config-reviewer-missing');

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(msgOf(issues[0])).toContain('reviewer');
  });

  it('does not emit config-reviewer-missing when reviewer section is present', async () => {
    const graph = createGraph({
      config: {
        reviewer: {
          tiers: {
            'default-tier': {
              provider: 'claude-code' as const,
              consensus: 1,
              max_tokens: 'auto' as const,
              temperature: 0,
              model: 'haiku',
            },
          },
        },
      },
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'config-reviewer-missing');

    expect(issues).toHaveLength(0);
  });

  it('does not emit config-reviewer-missing when configError is set', async () => {
    const graph = createGraph({ configError: 'parse error' });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'config-reviewer-missing');

    expect(issues).toHaveLength(0);
  });
});

describe('aspect-tier-unknown (Task 37)', () => {
  it('emits aspect-tier-unknown when aspect tier does not exist in config', async () => {
    const aspect = createAspect('my-aspect', { type: 'llm', tier: 'nonexistent-tier' } as any);
    const graph = createGraph({
      aspects: [aspect],
      config: {
        reviewer: {
          tiers: {
            'default-tier': {
              provider: 'claude-code' as const,
              consensus: 1,
              max_tokens: 'auto' as const,
              temperature: 0,
              model: 'haiku',
            },
          },
        },
      },
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-tier-unknown');

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(msgOf(issues[0])).toContain('my-aspect');
    expect(msgOf(issues[0])).toContain('nonexistent-tier');
  });

  it('does not emit aspect-tier-unknown when tier exists in config', async () => {
    const aspect = createAspect('my-aspect', { type: 'llm', tier: 'default-tier' } as any);
    const graph = createGraph({
      aspects: [aspect],
      config: {
        reviewer: {
          tiers: {
            'default-tier': {
              provider: 'claude-code' as const,
              consensus: 1,
              max_tokens: 'auto' as const,
              temperature: 0,
              model: 'haiku',
            },
          },
        },
      },
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-tier-unknown');

    expect(issues).toHaveLength(0);
  });

  it('does not emit aspect-tier-unknown for ast aspects even with a tier property', async () => {
    const aspect = createAspect('ast-aspect', 'deterministic');
    const graph = createGraph({ aspects: [aspect], config: {} });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-tier-unknown');

    expect(issues).toHaveLength(0);
  });

  it('does not emit aspect-tier-unknown when aspect has no tier', async () => {
    const aspect = createAspect('my-aspect', 'llm');
    const graph = createGraph({
      aspects: [aspect],
      config: {
        reviewer: {
          tiers: {
            'default-tier': {
              provider: 'claude-code' as const,
              consensus: 1,
              max_tokens: 'auto' as const,
              temperature: 0,
              model: 'haiku',
            },
          },
        },
      },
    });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-tier-unknown');

    expect(issues).toHaveLength(0);
  });

  it('does not emit aspect-tier-unknown when configError is set', async () => {
    const aspect = createAspect('my-aspect', { type: 'llm', tier: 'bad-tier' } as any);
    const graph = createGraph({ aspects: [aspect], configError: 'parse error' });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-tier-unknown');

    expect(issues).toHaveLength(0);
  });
});

describe('secrets-non-credential-field (Task 38)', () => {
  it('emits secrets-non-credential-field for non-api_key fields in yg-secrets.yaml', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-vr-secrets-foreign');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-123
    model: qwen3
`,
      'utf-8',
    );

    const graph = createGraph({ rootPath: tmpDir });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'secrets-non-credential-field');

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(msgOf(issues[0])).toContain('model');
    expect(msgOf(issues[0])).toContain('ollama');
  });

  it('does not emit secrets-non-credential-field when only api_key is present', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-vr-secrets-api-only');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-123
`,
      'utf-8',
    );

    const graph = createGraph({ rootPath: tmpDir });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'secrets-non-credential-field');

    expect(issues).toHaveLength(0);
  });

  it('emits one issue per foreign key across multiple providers', async () => {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-vr-secrets-multi-provider');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    model: qwen3
    temperature: 0.5
  claude:
    endpoint: https://api.example.com
`,
      'utf-8',
    );

    const graph = createGraph({ rootPath: tmpDir });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'secrets-non-credential-field');

    expect(issues).toHaveLength(3);
  });
});
