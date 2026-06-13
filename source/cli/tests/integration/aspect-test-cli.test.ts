import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const SCHEMAS_SRC = path.join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');
const distExists = existsSync(BIN);

const YG_CONFIG = `version: "5.0.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `node_types:
  module:
    description: Logical grouping
    log_required: false
`;

// A self-contained AST check using the raw tree-sitter Node API (no @chrisdudek/yg
// import) so it loads from /tmp without the loader hook. Flags sync fs calls.
const SYNC_FS_CHECK_MJS = `export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const calls = file.ast.rootNode.descendantsOfType('call_expression');
    for (const node of calls) {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      if (fn.text.includes('readFileSync') || fn.text.includes('writeFileSync')) {
        violations.push({ file: file.path, line: node.startPosition.row + 1, message: 'Use async fs APIs instead of sync' });
      }
    }
  }
  return violations;
}
`;

const BAD_TS = `import fs from 'node:fs';
export function readConfig(p) {
  return fs.readFileSync(p, 'utf-8');
}
`;

const CLEAN_TS = `import fs from 'node:fs/promises';
export async function readConfig(p) {
  return fs.readFile(p, 'utf-8');
}
`;

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function makeBaseProject(projectRoot: string): void {
  const ygg = path.join(projectRoot, '.yggdrasil');
  mkdirSync(path.join(ygg, 'schemas'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });

  // Copy required schema files from sample fixture
  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(path.join(SCHEMAS_SRC, schema), path.join(ygg, 'schemas', schema));
  }

  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: NodeN\ntype: module\nmapping:\n  - src/a.ts\n`,
  );
}

function writeAspect(projectRoot: string, id: string, yaml: string, check: string): void {
  const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(path.join(aspectDir, 'yg-aspect.yaml'), yaml);
  writeFileSync(path.join(aspectDir, 'check.mjs'), check);
}

// `yg aspect-test` replaces `yg deterministic-test`: it runs an aspect check
// WITHOUT touching the lock (diagnostic only), against a graph node (--node) or
// ad-hoc files (--files, deterministic only). Every run ends with the footer
// "diagnostic only — lock unchanged".
describe.skipIf(!distExists)('yg aspect-test', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-aspect-test-cli-'));
    makeBaseProject(projectRoot);
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // --- aspect / argument validation (shared by both modes) -----------------

  it('prints error and exits 1 when aspect is not found (mentions yg aspect-test)', () => {
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'nonexistent', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'nonexistent' not found");
    expect(stderr).toContain('yg aspect-test');
  });

  it('rejects --files with an llm aspect id (LLM needs graph context)', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'llm-aspect');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: LlmAspect\ndescription: llm aspect\nreviewer:\n  type: llm\n`,
    );
    writeFileSync(path.join(aspectDir, 'content.md'), `Code must be tidy.\n`);

    // --files is deterministic-only: an LLM review requires the node mapping,
    // effective aspects and tier config that an ad-hoc file list cannot supply.
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'llm-aspect', '--files', 'src/a.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('--files cannot be used with LLM aspect');
  });

  it('exits 1 when neither --node nor --files is provided', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(['aspect-test', '--aspect', 'clean'], projectRoot);
    expect(status).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  it('exits 1 when BOTH --node and --files are provided', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N', '--files', 'src/a.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('Both --node and --files');
  });

  it('--dry-run is rejected for a deterministic aspect (no prompt to print)', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N', '--dry-run'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('--dry-run is not supported for deterministic aspect');
  });

  // --- --node mode (graph-aware ctx) ---------------------------------------

  it('--node runs deterministic aspect against named node and prints violations', () => {
    writeAspect(
      projectRoot,
      'test',
      `name: Test\ndescription: test aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return [{ message: 'hi' }]; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'test', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('hi');
    // Diagnostic footer: the run never touches the lock.
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('--node prints "No violations." and exits 0 when check returns empty array', () => {
    writeAspect(
      projectRoot,
      'clean',
      `name: Clean\ndescription: clean aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'clean', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('--node prints error when node is not found', () => {
    writeAspect(
      projectRoot,
      'test2',
      `name: Test2\ndescription: test2\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'test2', '--node', 'missing/node'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'missing/node' not found");
  });

  it('--node renders file violations with file path and line (L<line>)', () => {
    writeAspect(
      projectRoot,
      'with-file',
      `name: WithFile\ndescription: with file\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) {
  return [{ message: 'found issue', file: 'src/a.ts', line: 1, column: 0 }];
}\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'with-file', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('L1: found issue');
  });

  it('--node renders graph-level violations (no file) as <graph>:', () => {
    writeAspect(
      projectRoot,
      'graph-level',
      `name: GraphLevel\ndescription: graph level\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return [{ message: 'graph violation' }]; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'graph-level', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('<graph>: graph violation');
  });

  it('--node surfaces a broken check (default export instead of named) with exit 1', () => {
    writeAspect(
      projectRoot,
      'broken',
      `name: Broken\ndescription: broken\nreviewer:\n  type: deterministic\n`,
      `export default function check(ctx) { return []; }\n`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'broken', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('DEFAULT_EXPORT');
  });

  it('--node --check-determinism exits 0 when results are stable', () => {
    writeAspect(
      projectRoot,
      'stable',
      `name: Stable\ndescription: stable aspect\nreviewer:\n  type: deterministic\n`,
      `export function check(ctx) { return []; }\n`,
    );
    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'stable', '--node', 'N', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--node --check-determinism exits 1 with Run 1/Run 2 dump for a non-deterministic check', () => {
    // A module-level counter makes the first invocation differ from the second,
    // so two consecutive runs within the process reliably disagree.
    writeAspect(
      projectRoot,
      'flaky-node',
      `name: FlakyNode\ndescription: flaky\nreviewer:\n  type: deterministic\n`,
      `let calls = 0;
export function check(ctx) {
  calls += 1;
  if (calls === 1) return [{ message: 'first-run-only violation' }];
  return [];
}
`,
    );
    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'flaky-node', '--node', 'N', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });

  // --- --files mode (AST runner + AST renderer) ----------------------------

  it('--files prints "No violations." and exits 0 for a clean file', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/clean.ts'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--files reports violations for a file using sync fs APIs (L<line>)', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'bad.ts'), BAD_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/bad.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/bad.ts');
    expect(stdout).toMatch(/L\d+: Use async fs APIs/);
  });

  it('--files groups violations by file across multiple files', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'a-bad.ts'), BAD_TS);
    writeFileSync(path.join(projectRoot, 'src', 'b-bad.ts'), BAD_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/b-bad.ts', 'src/a-bad.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a-bad.ts');
    expect(stdout).toContain('src/b-bad.ts');
    // The renderer sorts file groups alphabetically: a-bad before b-bad.
    expect(stdout.indexOf('src/a-bad.ts')).toBeLessThan(stdout.indexOf('src/b-bad.ts'));
  });

  it('--files surfaces a broken check (default export instead of named) with exit 1', () => {
    writeAspect(
      projectRoot,
      'broken-ast',
      `name: BrokenAst\ndescription: broken\nreviewer:\n  type: deterministic\n`,
      `export default function check(ctx) { return []; }\n`,
    );
    writeFileSync(path.join(projectRoot, 'src', 'x.ts'), 'export const y = 1;\n');

    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'broken-ast', '--files', 'src/x.ts'],
      projectRoot,
    );
    expect(status).toBe(1);
    // The AST runner's error does not prefix the code token into .message
    // (unlike the structure runner), so assert on the human wording.
    expect(stderr).toContain('NAMED export is required');
  });

  it('--files --check-determinism exits 0 when results are stable', () => {
    writeAspect(
      projectRoot,
      'async-fs',
      `name: AsyncFS\ndescription: async fs\nreviewer:\n  type: deterministic\n`,
      SYNC_FS_CHECK_MJS,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stdout, status } = run(
      ['aspect-test', '--aspect', 'async-fs', '--files', 'src/clean.ts', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('--files --check-determinism exits 1 with Run 1/Run 2 dump for a non-deterministic check', () => {
    // A module-level counter makes the two consecutive in-process runs disagree.
    writeAspect(
      projectRoot,
      'flaky-files',
      `name: FlakyFiles\ndescription: flaky\nreviewer:\n  type: deterministic\n`,
      `let calls = 0;
export function check(ctx) {
  calls += 1;
  if (calls === 1) {
    return ctx.files.map((f) => ({ file: f.path, line: 1, message: 'first-run-only violation' }));
  }
  return [];
}
`,
    );
    writeFileSync(path.join(projectRoot, 'src', 'clean.ts'), CLEAN_TS);

    const { stderr, status } = run(
      ['aspect-test', '--aspect', 'flaky-files', '--files', 'src/clean.ts', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
  });
});
