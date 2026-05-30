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

  it('runs deterministic aspects in dry-run and shows their section', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-dryrun-ast-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'no-foo'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const ok = 1;\n', 'utf-8');
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
    writeFileSync(join(ygg, 'aspects', 'no-foo', 'yg-aspect.yaml'), `name: NoFoo
description: forbids identifier foo
reviewer:
  type: deterministic
language: [typescript]
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'no-foo', 'check.mjs'), `export function check(ctx) {
  return [];
}
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/svc.ts
aspects:
  - no-foo
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'approve', '--dry-run', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(out).toContain('Deterministic aspect: no-foo');
    expect(out).toContain('no violations');
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

  it('dry-run iterates all LLM aspects, not just the first', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-dryrun-multi-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'b'), { recursive: true });
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
description: first aspect
reviewer: { type: llm }
references:
  - docs/codes.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'yg-aspect.yaml'), `name: B
description: second aspect
reviewer: { type: llm }
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'content.md'), '# B\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/svc.ts
aspects:
  - a
  - b
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'approve', '--dry-run', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    // Both LLM aspects must appear in dry-run output
    expect(out).toContain('Prompt for LLM aspect: a');
    expect(out).toContain('Prompt for LLM aspect: b');
    // Reference from aspect A should also appear
    expect(out).toContain('docs/codes.md');
    expect(out).toContain('CODE_1');
  });

  it('routes a structure aspect to the structure preview, never the LLM prompt path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-dryrun-structure-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'shape'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const ok = 1;\n', 'utf-8');
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
    writeFileSync(join(ygg, 'aspects', 'shape', 'yg-aspect.yaml'), `name: Shape
description: a structure-reviewer aspect
reviewer:
  type: deterministic
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'shape', 'check.mjs'), `export function check(ctx) {
  return [];
}
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/svc.ts
aspects:
  - shape
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'approve', '--dry-run', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(out).toContain('Deterministic aspect: shape');
    expect(out).toContain('no violations');
    expect(out).not.toContain('Prompt for LLM aspect: shape');
  });

  it('routes a former-ast aspect dry-run through the structure runner so the preview matches the verdict', () => {
    // A former-ast aspect on a PARENT that maps src/parent.ts AND src/child.ts,
    // with a CHILD node carving out src/child.ts. Real approve runs through the
    // structure runner, whose buildOwnFiles EXCLUDES the child-mapped path — so
    // the parent's own-file set is { src/parent.ts } only. The dry-run preview
    // must reflect the SAME set (preview-equals-verdict). Before Phase 4 the
    // dry-run used the AST runner over collectTrackedFiles (no child carve-out),
    // which would have surfaced src/child.ts too.
    const repo = mkdtempSync(join(tmpdir(), 'yg-dryrun-former-ast-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'count'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc', 'child'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'parent.ts'), 'export const p = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'src', 'child.ts'), 'export const c = 1;\n', 'utf-8');
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
  - id: leaf
    description: l
    allowed_parents: [module]
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'count', 'yg-aspect.yaml'), `name: Count
description: emits one violation per own file (former-ast)
reviewer:
  type: deterministic
language: [typescript]
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'count', 'check.mjs'), `export function check(ctx) {
  return ctx.files.map(f => ({ file: f.path, line: 1, column: 0, message: 'seen ' + f.path }));
}
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/parent.ts
  - src/child.ts
aspects:
  - count
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'child', 'yg-node.yaml'), `name: child
type: leaf
mapping:
  - src/child.ts
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'child', 'log.md'), '# log\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'approve', '--dry-run', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    // The former-ast aspect ran through the structure runner: the parent's own
    // file is reported...
    expect(out).toMatch(/seen src\/parent\.ts/);
    // ...and the child-mapped file is carved out (matches the real verdict).
    expect(out).not.toMatch(/seen src\/child\.ts/);
  });
});
