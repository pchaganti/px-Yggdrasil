import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');

describe('integration — approve --dry-run with references', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('prints <references> block in the captured prompt preview', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-dryrun-refs-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'x', 'utf-8');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), `
version: "5.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), `
node_types:
  - id: module
    description: m
    allowed_parents: []
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - docs/codes.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'approve', '--dry-run', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(out).toContain('<references>');
    expect(out).toContain('docs/codes.md');
    expect(out).toContain('CODE_1');
  });
});
