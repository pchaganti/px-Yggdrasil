import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempYggdrasil(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yg-test-'));
  tempDirs.push(base);
  const yggDir = path.join(base, '.yggdrasil');
  await mkdir(yggDir, { recursive: true });
  return yggDir;
}

async function createAspectDir(
  rootPath: string,
  aspectId: string,
  files: ('content.md' | 'check.mjs')[],
): Promise<void> {
  const aspectDir = path.join(rootPath, 'aspects', aspectId);
  await mkdir(aspectDir, { recursive: true });
  for (const file of files) {
    await writeFile(path.join(aspectDir, file), `// ${file} placeholder`);
  }
}

function makeAspect(id: string, reviewer?: AspectDef['reviewer'] | 'llm' | 'deterministic'): AspectDef {
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

function makeGraph(rootPath: string, overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath,
    ...overrides,
  };
}

// --- Test cases ---

describe('validator — aspect rule-source mutual exclusion', () => {
  it('reports aspect-missing-rule-source when reviewer is llm and content.md is absent', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created in the aspect dir — not even the dir itself
    const aspect = makeAspect('my-llm-aspect', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
  });

  it('reports aspect-missing-rule-source when reviewer is ast and check.mjs is absent', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created
    const aspect = makeAspect('my-ast-aspect', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
  });

  it('reports aspect-both-rule-sources AND aspect-unexpected-rule-source when reviewer is llm and both files exist', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'dual-llm', ['content.md', 'check.mjs']);
    const aspect = makeAspect('dual-llm', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-both-rule-sources');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reports aspect-both-rule-sources AND aspect-unexpected-rule-source when reviewer is ast and both files exist', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'dual-ast', ['content.md', 'check.mjs']);
    const aspect = makeAspect('dual-ast', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-both-rule-sources');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('does not report missing or unexpected errors when reviewer is ast and only check.mjs exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'clean-ast', ['check.mjs']);
    const aspect = makeAspect('clean-ast', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-missing-rule-source');
    expect(codes).not.toContain('aspect-unexpected-rule-source');
    expect(codes).not.toContain('aspect-both-rule-sources');
  });

  it('does not report missing-rule-source when reviewer is undefined and content.md exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'default-llm', ['content.md']);
    const aspect = makeAspect('default-llm'); // reviewer: undefined → treated as llm
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).not.toContain('aspect-missing-rule-source');
  });

  it('reports aspect-missing-rule-source AND aspect-unexpected-rule-source when reviewer is llm and only check.mjs exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'llm-wrong-file', ['check.mjs']);
    const aspect = makeAspect('llm-wrong-file', 'llm');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reports aspect-missing-rule-source AND aspect-unexpected-rule-source when reviewer is ast and only content.md exists', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'ast-wrong-file', ['content.md']);
    const aspect = makeAspect('ast-wrong-file', 'deterministic');
    const graph = makeGraph(rootPath, { aspects: [aspect] });

    const result = await validate(graph);
    const codes = result.issues.map((i) => i.code);

    expect(codes).toContain('aspect-missing-rule-source');
    expect(codes).toContain('aspect-unexpected-rule-source');
  });
});
