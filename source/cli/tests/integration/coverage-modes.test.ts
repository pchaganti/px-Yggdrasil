import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function scaffold(name: string, configYaml: string, extra: (root: string) => Promise<void>) {
  const tmpDir = path.join(__dirname, `../fixtures/tmp-covmode-${name}`);
  const ygg = path.join(tmpDir, '.yggdrasil');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(path.join(ygg, 'model', 'svc/s'), { recursive: true });
  await mkdir(path.join(ygg, '.drift-state'), { recursive: true });
  await mkdir(path.join(ygg, 'schemas'), { recursive: true });
  for (const s of ['yg-node', 'yg-aspect', 'yg-flow']) {
    await writeFile(path.join(ygg, 'schemas', `${s}.yaml`), 'type: x\n');
  }
  await writeFile(path.join(ygg, 'yg-config.yaml'), configYaml);
  await writeFile(path.join(ygg, 'model', 'svc', 'yg-node.yaml'), 'name: Svc\ntype: service\ndescription: p\n');
  await writeFile(path.join(ygg, 'model', 'svc/s', 'yg-node.yaml'),
    'name: S\ntype: service\ndescription: t\nmapping:\n  - src/svc/i.ts\n');
  await mkdir(path.join(tmpDir, 'src/svc'), { recursive: true });
  await writeFile(path.join(tmpDir, 'src/svc/i.ts'), '');
  await extra(tmpDir);
  return tmpDir;
}

describe('coverage modes integration', () => {
  it('scoped: required errors block, middle warns, excluded silent, nested skipped', async () => {
    const tmpDir = await scaffold(
      'scoped',
      'version: "5.0.0"\ncoverage:\n  required:\n    - src/svc/\n  excluded:\n    - vendor/\n',
      async (root) => {
        await mkdir(path.join(root, 'apps/.yggdrasil'), { recursive: true });
        await writeFile(path.join(root, 'apps/.yggdrasil/yg-config.yaml'), 'version: "5.0.0"\n');
        await mkdir(path.join(root, 'apps/web'), { recursive: true });
        await writeFile(path.join(root, 'apps/web/main.ts'), '');
      },
    );
    try {
      const graph = await loadGraph(tmpDir);
      const result = await runCheck(graph, [
        'src/svc/i.ts',        // covered
        'src/svc/extra.ts',    // required → error
        'lib/u.ts',            // middle → warning
        'vendor/v.ts',         // excluded → silent
        'apps/web/main.ts',    // nested → skipped
        'apps/.yggdrasil/yg-config.yaml',
      ]);
      const errs = result.issues.filter(i => i.code === 'unmapped-files');
      const warns = result.issues.filter(i => i.code === 'uncovered-advisory');
      expect(errs).toHaveLength(1);
      expect(warns).toHaveLength(1);
      expect(errs[0].uncoveredFiles).toEqual(['src/svc/extra.ts']);
      expect(warns[0].uncoveredFiles).toEqual(['lib/u.ts']);
      const all = [...errs, ...warns].flatMap(i => i.uncoveredFiles ?? []);
      expect(all).not.toContain('apps/web/main.ts');
      expect(all).not.toContain('vendor/v.ts');
      expect(all).not.toContain('apps/.yggdrasil/yg-config.yaml');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('default config reproduces today: every uncovered file is a blocking error', async () => {
    const tmpDir = await scaffold('default', 'version: "5.0.0"\n', async () => {});
    try {
      const graph = await loadGraph(tmpDir);
      const result = await runCheck(graph, ['src/svc/i.ts', 'lib/u.ts', 'README.md']);
      const errs = result.issues.filter(i => i.code === 'unmapped-files');
      expect(errs).toHaveLength(1);
      expect(errs[0].uncoveredFiles!.sort()).toEqual(['README.md', 'lib/u.ts']);
      expect(result.issues.filter(i => i.code === 'uncovered-advisory')).toHaveLength(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
