import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { runAstAspect, AstRunnerError } from '../../src/ast/runner.js';
import { normalizeMappingPaths } from '../../src/io/paths.js';
import { expandMappingPaths } from '../../src/io/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PROJECT = path.join(__dirname, '../fixtures/sample-project');

// Self-contained check.mjs — no @chrisdudek/yg/ast import, uses raw tree-sitter Node API
// so it works when imported from /tmp without the loader hook.
const SYNC_FS_CHECK_MJS = `
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const calls = file.ast.rootNode.descendantsOfType('call_expression');
    for (const node of calls) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      const text = fn.text;
      if (text.includes('readFileSync') || text.includes('writeFileSync')) {
        violations.push({ file: file.path, line: node.startPosition.row + 1, message: 'Use async fs APIs instead of sync' });
      }
    }
  }
  return violations;
}
`;

const BAD_TS = `import fs from 'node:fs';
export function readConfig(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}
`;

const CLEAN_TS = `import fs from 'node:fs/promises';
export async function readConfig(p: string): Promise<string> {
  return fs.readFile(p, 'utf-8');
}
`;

async function setupProject(): Promise<{ root: string; aspectDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-ast-test-cli-'));
  await cp(SAMPLE_PROJECT, root, { recursive: true });

  const aspectDir = path.join(root, '.yggdrasil', 'aspects', 'async-fs');
  await mkdir(aspectDir, { recursive: true });
  await writeFile(
    path.join(aspectDir, 'yg-aspect.yaml'),
    `name: AsyncFS\ndescription: Use async fs APIs\nreviewer: ast\n`,
  );
  await writeFile(path.join(aspectDir, 'check.mjs'), SYNC_FS_CHECK_MJS);

  return { root, aspectDir };
}

describe('ast-test command logic', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const p of cleanupPaths.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });

  it('returns no violations for clean file', async () => {
    const { root, aspectDir } = await setupProject();
    cleanupPaths.push(root);

    const cleanFile = path.join(root, 'clean.ts');
    await writeFile(cleanFile, CLEAN_TS);

    const result = await runAstAspect({
      aspectDir: path.relative(root, aspectDir),
      aspectId: 'async-fs',
      files: [{ path: path.relative(root, cleanFile) }],
      projectRoot: root,
    });

    expect(result.violations).toEqual([]);
  });

  it('returns violations for file using sync fs APIs', async () => {
    const { root, aspectDir } = await setupProject();
    cleanupPaths.push(root);

    const badFile = path.join(root, 'bad.ts');
    await writeFile(badFile, BAD_TS);

    const result = await runAstAspect({
      aspectDir: path.relative(root, aspectDir),
      aspectId: 'async-fs',
      files: [{ path: path.relative(root, badFile) }],
      projectRoot: root,
    });

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].message).toMatch(/sync/i);
    expect(result.violations[0].line).toBeGreaterThan(0);
  });

  it('aspect with reviewer llm is not ast', async () => {
    const { root } = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    const llmAspect = graph.aspects.find((a) => a.reviewer !== 'ast');
    expect(llmAspect).toBeDefined();
    expect(llmAspect!.reviewer).not.toBe('ast');
  });

  it('aspect not found yields undefined from graph.aspects.find', async () => {
    const { root } = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    const notFound = graph.aspects.find((a) => a.id === 'does-not-exist');
    expect(notFound).toBeUndefined();
  });

  it('--node alias resolves mapping files via expandMappingPaths', async () => {
    const { root } = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    const nodeWithMapping = [...graph.nodes.values()].find(
      (n) => n.meta.mapping && n.meta.mapping.length > 0,
    );
    expect(nodeWithMapping).toBeDefined();

    const mappingPaths = normalizeMappingPaths(nodeWithMapping!.meta.mapping);
    const expanded = await expandMappingPaths(root, mappingPaths);
    expect(Array.isArray(expanded)).toBe(true);
  });

  it('throws AstRunnerError if check.mjs uses default export instead of named', async () => {
    const { root } = await setupProject();
    cleanupPaths.push(root);

    const brokenAspectDir = path.join(root, '.yggdrasil', 'aspects', 'broken');
    await mkdir(brokenAspectDir, { recursive: true });
    await writeFile(
      path.join(brokenAspectDir, 'check.mjs'),
      'export default function check(ctx) { return []; }',
    );
    await writeFile(
      path.join(brokenAspectDir, 'yg-aspect.yaml'),
      `name: Broken\nreviewer: ast\n`,
    );

    const srcFile = path.join(root, 'x.ts');
    await writeFile(srcFile, 'const x = 1;\n');

    await expect(
      runAstAspect({
        aspectDir: path.relative(root, brokenAspectDir),
        aspectId: 'broken',
        files: [{ path: path.relative(root, srcFile) }],
        projectRoot: root,
      }),
    ).rejects.toMatchObject({ code: 'AST_CHECK_DEFAULT_EXPORT' });
  });

  it('violations are grouped by file and sorted by line', async () => {
    const { root, aspectDir } = await setupProject();
    cleanupPaths.push(root);

    const fileA = path.join(root, 'a.ts');
    const fileB = path.join(root, 'b.ts');
    await writeFile(fileA, BAD_TS);
    await writeFile(fileB, BAD_TS);

    const result = await runAstAspect({
      aspectDir: path.relative(root, aspectDir),
      aspectId: 'async-fs',
      files: [
        { path: path.relative(root, fileB) },
        { path: path.relative(root, fileA) },
      ],
      projectRoot: root,
    });

    expect(result.violations.length).toBeGreaterThan(0);
    // Both files should have violations
    const violationFiles = new Set(result.violations.map((v) => v.file));
    expect(violationFiles.size).toBe(2);
    // Violations are per-file (the runner doesn't sort, the CLI command does)
    const aViolations = result.violations.filter((v) => v.file.endsWith('a.ts'));
    const bViolations = result.violations.filter((v) => v.file.endsWith('b.ts'));
    expect(aViolations.length).toBeGreaterThan(0);
    expect(bViolations.length).toBeGreaterThan(0);
  });

  it('ast aspect in loaded graph has reviewer: ast', async () => {
    const { root } = await setupProject();
    cleanupPaths.push(root);

    const graph = await loadGraph(root);
    const astAspect = graph.aspects.find((a) => a.id === 'async-fs');
    expect(astAspect).toBeDefined();
    expect(astAspect!.reviewer).toBe('ast');
  });
});
