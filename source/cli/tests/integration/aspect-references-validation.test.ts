import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');
const SCHEMAS_SRC = join(__dirname, '..', 'fixtures', 'sample-project', '.yggdrasil', 'schemas');

const YG_CONFIG = `
version: "5.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`;

function ygCheck(repo: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, 'check'], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function makeBaseRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'yg-refs-val-'));
  const ygg = join(repo, '.yggdrasil');
  mkdirSync(join(ygg, 'schemas'), { recursive: true });
  mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
  mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });

  // Copy required schema files from sample fixture
  for (const schema of ['yg-node.yaml', 'yg-aspect.yaml', 'yg-flow.yaml']) {
    copyFileSync(join(SCHEMAS_SRC, schema), join(ygg, 'schemas', schema));
  }

  writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');
  writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
  writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
  writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');
  return repo;
}

describe('integration — aspect references validation', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('broken path (missing file) causes yg check to fail with aspect-reference-broken', () => {
    const repo = makeBaseRepo();
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    // Declare a reference to a non-existent file
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - docs/missing.md
`, 'utf-8');

    const { code, out } = ygCheck(repo);
    expect(code).toBe(1);
    expect(out).toContain('aspect-reference-broken');
  });

  it('references on AST aspect causes yg check to fail with aspect-references-on-ast', () => {
    const repo = makeBaseRepo();
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    writeFileSync(join(repo, 'docs', 'x.md'), 'content\n', 'utf-8');
    // AST aspect with references — invalid combination
    // Note: language is a top-level field (not under reviewer:)
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer:
  type: ast
language: [ts]
references:
  - docs/x.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'check.mjs'), 'export default function check() { return []; }\n', 'utf-8');

    const { code, out } = ygCheck(repo);
    expect(code).toBe(1);
    expect(out).toContain('aspect-references-on-ast');
  });

  it('happy path — existing reference file produces no reference-related errors', () => {
    const repo = makeBaseRepo();
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1\nCODE_2\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - docs/codes.md
`, 'utf-8');

    const { out } = ygCheck(repo);
    expect(out).not.toContain('aspect-reference-broken');
    expect(out).not.toContain('aspect-references-on-ast');
    expect(out).not.toContain('aspect-reference-too-large');
  });
});
