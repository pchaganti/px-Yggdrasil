import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { validate } from '../../../src/core/validator.js';
import type { Graph, AspectDef, LlmConfig, ReviewerConfig } from '../../../src/model/graph.js';

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

describe('validator — reference size limits', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  function makeSizeTierConfig(overrides: Partial<NonNullable<LlmConfig['references']>> = {}): ReviewerConfig {
    const refs = { max_bytes_per_file: 100, max_total_bytes_per_aspect: 200, ...overrides };
    return {
      default: 'standard',
      tiers: {
        standard: {
          provider: 'ollama',
          model: 'm',
          endpoint: 'http://x',
          temperature: 0,
          consensus: 1,
          references: refs,
        },
      },
    };
  }

  it('flags reference exceeding per-file limit', async () => {
    const tmpRoot = path.join(os.tmpdir(), `yg-refs-size-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repos.push(tmpRoot);
    const yggRoot = path.join(tmpRoot, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'a'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    mkdirSync(path.join(tmpRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'docs', 'big.md'), 'x'.repeat(200), 'utf-8');
    const graph = makeGraph(yggRoot, {
      config: { reviewer: makeSizeTierConfig({ max_bytes_per_file: 100 }) },
      aspects: [makeAspect([{ path: 'docs/big.md' }])],
    });
    const result = await validate(graph);
    const too = result.issues.find(i => i.code === 'aspect-reference-too-large');
    expect(too).toBeDefined();
    // Message should include tier name and KiB/bytes formatting
    expect(too?.messageData.what).toContain("'standard'");
    expect(too?.messageData.what).toMatch(/\d+ bytes|\d+ KiB/);
  });

  it('flags total references exceeding per-aspect limit', async () => {
    const tmpRoot = path.join(os.tmpdir(), `yg-refs-total-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repos.push(tmpRoot);
    const yggRoot = path.join(tmpRoot, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'a'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    mkdirSync(path.join(tmpRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'docs', 'a.md'), 'x'.repeat(150), 'utf-8');
    writeFileSync(path.join(tmpRoot, 'docs', 'b.md'), 'x'.repeat(150), 'utf-8');
    const graph = makeGraph(yggRoot, {
      config: { reviewer: makeSizeTierConfig({ max_bytes_per_file: 1000, max_total_bytes_per_aspect: 200 }) },
      aspects: [makeAspect([{ path: 'docs/a.md' }, { path: 'docs/b.md' }])],
    });
    const result = await validate(graph);
    const tot = result.issues.find(i => i.code === 'aspect-references-total-too-large');
    expect(tot).toBeDefined();
    // Message should include tier name and KiB/bytes formatting
    expect(tot?.messageData.what).toContain("'standard'");
    expect(tot?.messageData.what).toMatch(/\d+ bytes|\d+ KiB/);
  });

  it('uses defaults (64 KiB / 256 KiB) when tier omits references config', async () => {
    const tmpRoot = path.join(os.tmpdir(), `yg-refs-defaults-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repos.push(tmpRoot);
    const yggRoot = path.join(tmpRoot, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'a'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    mkdirSync(path.join(tmpRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'docs', 'small.md'), 'x'.repeat(1024), 'utf-8');
    // Config with no references field
    const reviewerConfig: ReviewerConfig = {
      default: 'standard',
      tiers: {
        standard: {
          provider: 'ollama',
          model: 'm',
          endpoint: 'http://x',
          temperature: 0,
          consensus: 1,
          // no references field → defaults apply
        },
      },
    };
    const graph = makeGraph(yggRoot, {
      config: { reviewer: reviewerConfig },
      aspects: [makeAspect([{ path: 'docs/small.md' }])],
    });
    const result = await validate(graph);
    expect(result.issues.find(i => i.code === 'aspect-reference-too-large')).toBeUndefined();
    expect(result.issues.find(i => i.code === 'aspect-references-total-too-large')).toBeUndefined();
  });

  it('aspect-references-empty-array: warning when references: [] declared explicitly', async () => {
    const tmpRoot = path.join(os.tmpdir(), `yg-refs-empty-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    repos.push(tmpRoot);
    const yggRoot = path.join(tmpRoot, '.yggdrasil');
    mkdirSync(path.join(yggRoot, 'aspects', 'a'), { recursive: true });
    writeFileSync(path.join(yggRoot, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    const aspectWithEmptyRefs: AspectDef = {
      name: 'A',
      id: 'a',
      description: 'test',
      reviewer: { type: 'llm' },
      artifacts: [],
      references: [], // explicitly empty
    };
    const graph = makeGraph(yggRoot, {
      aspects: [aspectWithEmptyRefs],
    });
    const result = await validate(graph);
    const warn = result.issues.find(i => i.code === 'aspect-references-empty-array');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });
});
