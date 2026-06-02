import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkAspectRuleSources } from '../../../src/core/checks/aspect-contracts.js';
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

function makeAggregate(id: string, implies: string[] | undefined): AspectDef {
  return {
    name: id,
    id,
    description: `Aggregate ${id}`,
    artifacts: [],
    reviewer: { type: 'aggregate' },
    implies,
  };
}

function makeGraph(rootPath: string, aspects: AspectDef[]): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects,
    flows: [],
    schemas: [],
    rootPath,
  };
}

describe('checkAspectRuleSources — aggregating aspect', () => {
  it('reports no rule-source error for an aggregate with neither file and implies set', async () => {
    const rootPath = await createTempYggdrasil();
    // No files created — aggregate ships neither content.md nor check.mjs.
    const graph = makeGraph(rootPath, [makeAggregate('bundle', ['rule-a'])]);
    const codes = checkAspectRuleSources(graph).map(i => i.code);
    expect(codes).not.toContain('aspect-missing-rule-source');
    expect(codes).not.toContain('aspect-unexpected-rule-source');
    expect(codes).not.toContain('aspect-both-rule-sources');
    expect(codes).not.toContain('aspect-empty');
  });

  it('reports aspect-empty for an aggregate with neither file and no implies', async () => {
    const rootPath = await createTempYggdrasil();
    const graph = makeGraph(rootPath, [makeAggregate('does-nothing', undefined)]);
    const codes = checkAspectRuleSources(graph).map(i => i.code);
    expect(codes).toContain('aspect-empty');
  });

  it('reports aspect-empty for an aggregate with an empty implies list', async () => {
    const rootPath = await createTempYggdrasil();
    const graph = makeGraph(rootPath, [makeAggregate('does-nothing', [])]);
    const codes = checkAspectRuleSources(graph).map(i => i.code);
    expect(codes).toContain('aspect-empty');
  });

  it('reports aspect-unexpected-rule-source when an aggregate ships a content.md', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'contradiction', ['content.md']);
    const graph = makeGraph(rootPath, [makeAggregate('contradiction', ['rule-a'])]);
    const codes = checkAspectRuleSources(graph).map(i => i.code);
    expect(codes).toContain('aspect-unexpected-rule-source');
  });

  it('reports aspect-unexpected-rule-source when an aggregate ships a check.mjs', async () => {
    const rootPath = await createTempYggdrasil();
    await createAspectDir(rootPath, 'contradiction', ['check.mjs']);
    const graph = makeGraph(rootPath, [makeAggregate('contradiction', ['rule-a'])]);
    const codes = checkAspectRuleSources(graph).map(i => i.code);
    expect(codes).toContain('aspect-unexpected-rule-source');
  });
});
