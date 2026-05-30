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
  it('an ast aspect with no language: field validates clean (D2: language removed)', async () => {
    const f = await fixture(`name: T\nid: t\nreviewer:\n  type: ast\ndescription: x\n`);
    try {
      const graph = await loadGraph(f.projectRoot);
      const result = await validate(graph);
      const langCodes = ['aspect-ast-missing-language', 'aspect-language-not-array', 'aspect-empty-language-list', 'aspect-unknown-language'];
      const issues = result.issues;
      expect(issues.filter((i: any) => langCodes.includes(i.code ?? ''))).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
