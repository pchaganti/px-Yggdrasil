import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
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

describe.skipIf(!distExists)('yg structure-test', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-cli-'));
    makeBaseProject(projectRoot);
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('runs structure aspect against named node and prints violations', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'test');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: Test\ndescription: test aspect\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return [{ message: 'hi' }]; }\n`,
    );

    const { stdout, status } = run(['structure-test', '--aspect', 'test', '--node', 'N'], projectRoot);
    expect(status).toBe(1);
    expect(stdout).toContain('hi');
  });

  it('prints "No violations." and exits 0 when check returns empty array', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'clean');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: Clean\ndescription: clean aspect\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return []; }\n`,
    );

    const { stdout, status } = run(['structure-test', '--aspect', 'clean', '--node', 'N'], projectRoot);
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('rejects non-structure aspect id with exit code 1', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'ast-aspect');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: AstAspect\ndescription: ast aspect\nreviewer:\n  type: ast\nlanguage: [typescript]\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return []; }\n`,
    );

    const { stderr, status } = run(
      ['structure-test', '--aspect', 'ast-aspect', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("not 'structure'");
  });

  it('prints error when aspect is not found', () => {
    const { stderr, status } = run(
      ['structure-test', '--aspect', 'nonexistent', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'nonexistent' not found");
  });

  it('prints error when node is not found', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'test2');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: Test2\ndescription: test2\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return []; }\n`,
    );

    const { stderr, status } = run(
      ['structure-test', '--aspect', 'test2', '--node', 'missing/node'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stderr).toContain("'missing/node' not found");
  });

  it('--check-determinism exits 0 when results are stable', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'stable');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: Stable\ndescription: stable aspect\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return []; }\n`,
    );

    const { stdout, status } = run(
      ['structure-test', '--aspect', 'stable', '--node', 'N', '--check-determinism'],
      projectRoot,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('No violations.');
  });

  it('renders file violations with file path and line', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'with-file');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: WithFile\ndescription: with file\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) {
  return [{ message: 'found issue', file: 'src/a.ts', line: 1, column: 0 }];
}\n`,
    );

    const { stdout, status } = run(
      ['structure-test', '--aspect', 'with-file', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts');
    expect(stdout).toContain('found issue');
  });

  it('renders graph-level violations (no file) as <graph>:', () => {
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', 'graph-level');
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      `name: GraphLevel\ndescription: graph level\nreviewer:\n  type: structure\n`,
    );
    writeFileSync(
      path.join(aspectDir, 'check.mjs'),
      `export function check(ctx) { return [{ message: 'graph violation' }]; }\n`,
    );

    const { stdout, status } = run(
      ['structure-test', '--aspect', 'graph-level', '--node', 'N'],
      projectRoot,
    );
    expect(status).toBe(1);
    expect(stdout).toContain('<graph>: graph violation');
  });
});
