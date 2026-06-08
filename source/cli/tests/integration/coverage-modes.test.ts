import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck } from '../../src/core/check.js';
import { recordBaselineForAllMappedNodes } from '../unit/helpers/seed-baseline.js';

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

async function scaffoldWithArchitecture(
  name: string,
  configYaml: string,
  architectureYaml: string,
  extra: (root: string) => Promise<void>,
) {
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
  await writeFile(path.join(ygg, 'yg-architecture.yaml'), architectureYaml);
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

  it('Fix 6: advisory-only coverage run exits with no errors (exit 0 contract)', async () => {
    // A scoped coverage config where uncovered files fall only in the middle
    // (advisory warning) tier — no required-tier errors, no drift, no other issues.
    // Guards: hasErrors === false → CLI exits 0.
    // The config includes a reviewer tier so config-reviewer-missing does not fire.
    const configYaml = [
      'version: "5.0.0"',
      'coverage:',
      '  required:',
      '    - src/svc/',
      '  excluded:',
      '    - vendor/',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: test',
      '        endpoint: http://127.0.0.1:11434',
      '',
    ].join('\n');
    const tmpDir = await scaffold('advisory-exit0', configYaml, async () => {});
    try {
      const graph = await loadGraph(tmpDir);
      // lib/u.ts is outside src/svc/ (no required match) and outside vendor/ (not excluded)
      // → falls to middle tier → uncovered-advisory warning only
      const result = await runCheck(graph, ['src/svc/i.ts', 'lib/u.ts']);
      const errs = result.issues.filter(i => i.severity === 'error');
      const warns = result.issues.filter(i => i.code === 'uncovered-advisory');
      // No errors → exit 0 contract satisfied
      expect(errs).toHaveLength(0);
      // Advisory warning present to confirm the test exercises the advisory path
      expect(warns).toHaveLength(1);
      expect(warns[0].uncoveredFiles).toContain('lib/u.ts');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Fix 7b: nested .yggdrasil subtree skipped even when architecture has strict enforce', async () => {
    // A node_type with enforce: strict whose when matches apps/** — nested subtree
    // files under apps/.yggdrasil/ must be skipped before strict-coverage checks
    // at the shared walkRepoFiles level, not just at scanUncoveredFiles.
    const architectureYaml = [
      'node_types:',
      '  service:',
      "    description: 'A service'",
      '    log_required: false',
      '    enforce: strict',
      '    when:',
      '      path: "apps/**"',
      '',
    ].join('\n');
    const tmpDir = await scaffoldWithArchitecture(
      'strict-nested-skip',
      'version: "5.0.0"\n',
      architectureYaml,
      async (root) => {
        await mkdir(path.join(root, 'apps/.yggdrasil'), { recursive: true });
        await writeFile(path.join(root, 'apps/.yggdrasil/yg-config.yaml'), 'version: "5.0.0"\n');
        await mkdir(path.join(root, 'apps/web'), { recursive: true });
        await writeFile(path.join(root, 'apps/web/main.ts'), '');
      },
    );
    try {
      const graph = await loadGraph(tmpDir);
      // Baseline required to avoid source-drift noise
      await recordBaselineForAllMappedNodes(graph);
      const freshGraph = await loadGraph(tmpDir);
      const result = await runCheck(freshGraph, [
        'src/svc/i.ts',                        // covered by node
        'apps/web/main.ts',                    // under apps/ but nested-skip should exclude via .yggdrasil skip
        'apps/.yggdrasil/yg-config.yaml',      // nested .yggdrasil — must be skipped
      ]);
      const strictIssues = result.issues.filter(i =>
        i.code === 'type-strict-orphan' || i.code === 'type-strict-misplaced',
      );
      const allUncoveredFiles = result.issues.flatMap(i => i.uncoveredFiles ?? []);
      // If excludeNestedGraphSubtrees were removed from walkRepoFiles, the strict-backward
      // check would walk apps/web/main.ts + apps/.yggdrasil/yg-config.yaml — both match the
      // service enforce:strict when 'apps/**' and are owned by no service node — and emit
      // type-strict-orphan. The shared-enumeration nested-skip must suppress that entirely.
      expect(strictIssues).toHaveLength(0);
      // And neither nested file appears in any uncovered list.
      expect(allUncoveredFiles).not.toContain('apps/web/main.ts');
      expect(allUncoveredFiles).not.toContain('apps/.yggdrasil/yg-config.yaml');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
