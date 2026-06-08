import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { excludeNestedGraphSubtrees, walkRepoFiles } from '../../../src/io/repo-scanner.js';

describe('excludeNestedGraphSubtrees', () => {
  it('drops a subtree that has its own nested .yggdrasil', () => {
    const out = excludeNestedGraphSubtrees([
      'src/a.ts',
      'apps/.yggdrasil/yg-config.yaml',
      'apps/web/index.ts',
      'apps/web/util.ts',
    ]);
    expect(out).toEqual(['src/a.ts']);
  });
  it('does NOT treat the top-level .yggdrasil as a nested root', () => {
    const out = excludeNestedGraphSubtrees(['.yggdrasil/model/x/yg-node.yaml', 'src/a.ts']);
    expect(out.sort()).toEqual(['.yggdrasil/model/x/yg-node.yaml', 'src/a.ts']);
  });
  it('returns the input unchanged when no nested graphs exist', () => {
    const input = ['src/a.ts', 'lib/b.ts'];
    expect(excludeNestedGraphSubtrees(input)).toEqual(input);
  });
});

describe('walkRepoFiles nested-graph integration', () => {
  it('drops a real nested .yggdrasil subtree from the walk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-walk-nested-'));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src/a.ts'), '');
      await mkdir(path.join(root, 'apps/web'), { recursive: true });
      await writeFile(path.join(root, 'apps/web/main.ts'), '');
      await mkdir(path.join(root, 'apps/.yggdrasil'), { recursive: true });
      await writeFile(path.join(root, 'apps/.yggdrasil/yg-config.yaml'), '');
      const files = await walkRepoFiles(root);
      expect(files).toContain('src/a.ts');
      expect(files.every((f) => !f.startsWith('apps/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
