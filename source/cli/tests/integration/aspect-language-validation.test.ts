import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

async function fixture(aspectYaml: string): Promise<{ projectRoot: string; cleanup: () => Promise<void> }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'aspect-lang-val-'));
  const ygDir = path.join(projectRoot, '.yggdrasil');
  await mkdir(path.join(ygDir, 'aspects', 't'), { recursive: true });
  await mkdir(path.join(ygDir, 'model'), { recursive: true });
  await mkdir(path.join(ygDir, 'flows'), { recursive: true });
  await writeFile(
    path.join(ygDir, 'yg-architecture.yaml'),
    `node_types:\n  module:\n    description: Logical grouping\n`,
  );
  await writeFile(path.join(ygDir, 'yg-config.yaml'), `quality:\n  max_direct_relations: 10\n`);
  await writeFile(path.join(ygDir, 'aspects', 't', 'yg-aspect.yaml'), aspectYaml);
  await writeFile(path.join(ygDir, 'aspects', 't', 'check.mjs'), 'export function check() { return []; }');
  return { projectRoot, cleanup: () => rm(projectRoot, { recursive: true, force: true }) };
}

describe('aspect language validation', () => {
  it('aspect-ast-missing-language', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: ast\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some((i: any) => i.code === 'aspect-ast-missing-language')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('aspect-language-not-array', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: ast\nlanguage: typescript\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some((i: any) => i.code === 'aspect-language-not-array')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('aspect-empty-language-list', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: ast\nlanguage: []\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some((i: any) => i.code === 'aspect-empty-language-list')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('aspect-unknown-language', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: ast\nlanguage: [martian]\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some((i: any) => i.code === 'aspect-unknown-language')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('valid language passes', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: ast\nlanguage: [typescript]\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      const langCodes = ['aspect-ast-missing-language', 'aspect-language-not-array', 'aspect-empty-language-list', 'aspect-unknown-language'];
      expect(result.issues.filter((i: any) => langCodes.includes(i.code ?? ''))).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('LLM aspect with unknown language fires aspect-unknown-language', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer: llm\ncontent_file: content.md\nlanguage: [martian]\ndescription: x\n`);
    try {
      const ygDir = path.join(f.projectRoot, '.yggdrasil');
      await writeFile(path.join(ygDir, 'aspects', 't', 'content.md'), '# T\n');
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      expect(result.issues.some((i: any) => i.code === 'aspect-unknown-language')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});
