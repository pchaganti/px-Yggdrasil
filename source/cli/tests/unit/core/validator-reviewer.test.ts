import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../src/core/validator.js';
import type { Graph, GraphNode, AspectDef } from '../../../src/model/graph.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
const msgOf = (i: { messageData: Parameters<typeof buildIssueMessage>[0] }) => buildIssueMessage(i.messageData);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');

function createAspect(id: string, reviewer?: AspectDef['reviewer']): AspectDef {
  return {
    name: id,
    id,
    description: `Test aspect ${id}`,
    artifacts: [],
    ...(reviewer !== undefined ? { reviewer } : {}),
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

describe('validator — reviewer enum check', () => {
  it('reports aspect-invalid-reviewer for an invalid reviewer value', async () => {
    const aspect = createAspect('my-aspect');
    // Simulate an invalid value that bypassed the parser (e.g., via code path)
    (aspect as any).reviewer = 'foo';
    const graph = createGraph({ aspects: [aspect] });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-invalid-reviewer');

    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].code).toBe('aspect-invalid-reviewer');
    expect(msgOf(issues[0])).toContain("my-aspect");
    expect(msgOf(issues[0])).toContain("foo");
  });

  it('does not report aspect-invalid-reviewer for reviewer: llm', async () => {
    const graph = createGraph({ aspects: [createAspect('llm-aspect', 'llm')] });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-invalid-reviewer');

    expect(issues).toHaveLength(0);
  });

  it('does not report aspect-invalid-reviewer for reviewer: ast', async () => {
    const graph = createGraph({ aspects: [createAspect('ast-aspect', 'ast')] });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-invalid-reviewer');

    expect(issues).toHaveLength(0);
  });

  it('does not report aspect-invalid-reviewer when reviewer is undefined', async () => {
    const graph = createGraph({ aspects: [createAspect('no-reviewer-aspect')] });

    const result = await validate(graph);
    const issues = result.issues.filter((i) => i.code === 'aspect-invalid-reviewer');

    expect(issues).toHaveLength(0);
  });
});
