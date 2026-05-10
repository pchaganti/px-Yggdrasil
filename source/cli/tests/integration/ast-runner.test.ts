import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAstAspect, AstRunnerError } from '../../src/ast/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, '../..');  // source/cli/

describe('ast runner', () => {
  it('runs check.mjs and returns violations for bad file', async () => {
    const result = await runAstAspect({
      aspectDir: 'tests/fixtures/ast-aspects/async-fs',
      aspectId: 'async-fs',
      files: [{ path: 'tests/fixtures/async-fs-bad.ts' }],
      projectRoot: CWD,
    });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].message).toMatch(/readFileSync|sync/i);
  });

  it('returns empty violations for clean file', async () => {
    const result = await runAstAspect({
      aspectDir: 'tests/fixtures/ast-aspects/async-fs',
      aspectId: 'async-fs',
      files: [{ path: 'tests/fixtures/async-fs-clean.ts' }],
      projectRoot: CWD,
    });
    expect(result.violations).toEqual([]);
  });

  it('AST_CHECK_WRONG_ARITY for check(a, b)', async () => {
    // Create a temp fixture inline
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-'));
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check(a, b) { return []; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(runAstAspect({
      aspectDir: dir,
      aspectId: 'test',
      files: [{ path: tmpFile }],
      projectRoot: '/',
    })).rejects.toMatchObject({ code: 'AST_CHECK_WRONG_ARITY' });
  });

  it('AST_CHECK_THROWN with stack in message', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-'));
    writeFileSync(path.join(dir, 'check.mjs'), "export function check(ctx) { throw new Error('boom'); }");
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    try {
      await runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' });
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('AST_CHECK_THROWN');
      expect(e.message).toContain('boom');
    }
  });

  it('AST_CHECK_DEFAULT_EXPORT when check is default export', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-'));
    writeFileSync(path.join(dir, 'check.mjs'), 'export default function check(ctx) { return []; }');
    const tmpFile = path.join(dir, 'x.ts');
    writeFileSync(tmpFile, 'const x = 1;');
    await expect(runAstAspect({ aspectDir: dir, aspectId: 'test', files: [{ path: tmpFile }], projectRoot: '/' }))
      .rejects.toMatchObject({ code: 'AST_CHECK_DEFAULT_EXPORT' });
  });

  it('suppressed violation is filtered from results', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-test-'));
    // check.mjs: flag all call_expressions — no @chrisdudek/yg/ast import needed,
    // we use the raw tree-sitter API via ctx.files[].ast directly.
    writeFileSync(path.join(dir, 'check.mjs'), `
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    for (const node of file.ast.rootNode.descendantsOfType('call_expression')) {
      violations.push({ file: file.path, line: node.startPosition.row + 1, message: 'test violation' });
    }
  }
  return violations;
}
`);
    const srcFile = path.join(dir, 'src.ts');
    // Line 1: normal call — NOT suppressed
    // Line 2: suppress marker
    // Line 3: suppressed call
    writeFileSync(srcFile, 'foo();\n// yg-suppress(test) refactor\nbar();\n');
    const result = await runAstAspect({
      aspectDir: dir,
      aspectId: 'test',
      files: [{ path: srcFile }],
      projectRoot: '/',
    });
    // bar() on line 3 should be suppressed; foo() on line 1 should not
    const lines = result.violations.map(v => v.line);
    expect(lines).toContain(1); // foo() not suppressed
    expect(lines).not.toContain(3); // bar() suppressed
  });
});
