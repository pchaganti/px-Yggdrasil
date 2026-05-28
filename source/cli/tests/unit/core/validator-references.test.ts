import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { validate } from '../../../src/core/validator.js';
import type { Graph, AspectDef } from '../../../src/model/graph.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempRepo(): Promise<{ projectRoot: string; yggRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'yg-validator-refs-'));
  tempDirs.push(projectRoot);
  const yggRoot = path.join(projectRoot, '.yggdrasil');
  await mkdir(yggRoot, { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'a'), { recursive: true });
  await writeFile(
    path.join(yggRoot, 'aspects', 'a', 'content.md'),
    '# A\n',
    'utf-8',
  );
  return { projectRoot, yggRoot };
}

function makeAspect(
  refs: Array<{ path: string; description?: string }>,
): AspectDef {
  return {
    name: 'A',
    id: 'a',
    description: 'test',
    reviewer: { type: 'llm' },
    artifacts: [],
    references: refs,
  };
}

function makeGraph(yggRoot: string, overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [],
    flows: [],
    schemas: [],
    rootPath: yggRoot,
    ...overrides,
  };
}

describe('validator — aspect-reference-broken', () => {
  it('flags missing file', async () => {
    const { yggRoot } = await createTempRepo();
    const graph = makeGraph(yggRoot, {
      aspects: [makeAspect([{ path: 'docs/missing.md' }])],
    });
    const result = await validate(graph);
    const broken = result.issues.find((i) => i.code === 'aspect-reference-broken');
    expect(broken).toBeDefined();
    expect(broken?.messageData.what).toContain('docs/missing.md');
  });

  it('flags directory targets', async () => {
    const { projectRoot, yggRoot } = await createTempRepo();
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    const graph = makeGraph(yggRoot, {
      aspects: [makeAspect([{ path: 'docs' }])],
    });
    const result = await validate(graph);
    const broken = result.issues.find((i) => i.code === 'aspect-reference-broken');
    expect(broken).toBeDefined();
  });

  it('accepts existing regular file', async () => {
    const { projectRoot, yggRoot } = await createTempRepo();
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await writeFile(path.join(projectRoot, 'docs', 'x.md'), 'x', 'utf-8');
    const graph = makeGraph(yggRoot, {
      aspects: [makeAspect([{ path: 'docs/x.md' }])],
    });
    const result = await validate(graph);
    const broken = result.issues.find((i) => i.code === 'aspect-reference-broken');
    expect(broken).toBeUndefined();
  });

  it('follows symlinks to file', async () => {
    const { projectRoot, yggRoot } = await createTempRepo();
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await writeFile(path.join(projectRoot, 'docs', 'real.md'), 'r', 'utf-8');
    await symlink('real.md', path.join(projectRoot, 'docs', 'link.md'));
    const graph = makeGraph(yggRoot, {
      aspects: [makeAspect([{ path: 'docs/link.md' }])],
    });
    const result = await validate(graph);
    const broken = result.issues.find((i) => i.code === 'aspect-reference-broken');
    expect(broken).toBeUndefined();
  });
});
