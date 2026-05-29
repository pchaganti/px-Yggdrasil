import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  migrateTo50,
  transformConfigReviewer,
  transformAspectReviewer,
} from '../../../src/migrations/to-5.0.0.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupYgg(opts: {
  config?: string;
  aspects?: Record<string, string>;
  secrets?: string;
  nodes?: Record<string, string>;
  architecture?: string;
  flows?: Record<string, string>;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-mig50-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(ygg, { recursive: true });
  if (opts.config !== undefined) {
    await writeFile(path.join(ygg, 'yg-config.yaml'), opts.config);
  }
  if (opts.aspects) {
    const aspectsDir = path.join(ygg, 'aspects');
    await mkdir(aspectsDir, { recursive: true });
    for (const [id, yaml] of Object.entries(opts.aspects)) {
      const dir = path.join(aspectsDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'yg-aspect.yaml'), yaml);
    }
  }
  if (opts.secrets !== undefined) {
    await writeFile(path.join(ygg, 'yg-secrets.yaml'), opts.secrets);
  }
  if (opts.nodes) {
    const modelDir = path.join(ygg, 'model');
    await mkdir(modelDir, { recursive: true });
    for (const [nodePath, yaml] of Object.entries(opts.nodes)) {
      const dir = path.join(modelDir, nodePath);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'yg-node.yaml'), yaml);
    }
  }
  if (opts.architecture !== undefined) {
    await writeFile(path.join(ygg, 'yg-architecture.yaml'), opts.architecture);
  }
  if (opts.flows) {
    const flowsDir = path.join(ygg, 'flows');
    await mkdir(flowsDir, { recursive: true });
    for (const [name, yaml] of Object.entries(opts.flows)) {
      const dir = path.join(flowsDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'yg-flow.yaml'), yaml);
    }
  }
  return ygg;
}

// ── transformConfigReviewer unit tests ──────────────────────

describe('transformConfigReviewer', () => {
  it('returns undefined when already on tiers shape', () => {
    const result = transformConfigReviewer({ tiers: {} });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('returns undefined when no provider keys and no active', () => {
    const result = transformConfigReviewer({ someUnknown: 'val' });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('transforms single provider (no active key) into tier named after the provider', () => {
    const result = transformConfigReviewer({
      consensus: 1,
      ollama: { model: 'qwen3', temperature: 0.1 },
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.value).toEqual({
      tiers: {
        ollama: {
          provider: 'ollama',
          consensus: 1,
          config: { model: 'qwen3', temperature: 0.1 },
        },
      },
    });
  });

  it('transforms with explicit active key into matching tier name + default', () => {
    const result = transformConfigReviewer({
      active: 'claude-code',
      consensus: 3,
      ollama: { model: 'qwen3' },
      'claude-code': { model: 'haiku' },
    });
    expect(result.changed).toBe(true);
    const tiers = (result.value as { tiers: Record<string, unknown> }).tiers;
    expect(Object.keys(tiers).sort()).toEqual(['claude-code', 'ollama']);
    expect((tiers['claude-code'] as { provider: string }).provider).toBe('claude-code');
    expect((tiers.ollama as { provider: string }).provider).toBe('ollama');
    expect((tiers['claude-code'] as { consensus: number }).consensus).toBe(3);
    expect((tiers['claude-code'] as { config: unknown }).config).toEqual({ model: 'haiku' });
    expect((result.value as { default: string }).default).toBe('claude-code');
    expect(result.actions.some(a => a.includes('consensus 3'))).toBe(true);
  });

  it('omits default key when single provider', () => {
    const result = transformConfigReviewer({ ollama: { model: 'q' } });
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, unknown>).default).toBeUndefined();
  });

  it('defaults global consensus to 1 when missing', () => {
    const result = transformConfigReviewer({ ollama: { model: 'x' } });
    expect((result.value as { tiers: Record<string, { consensus: number }> }).tiers.ollama.consensus).toBe(1);
    expect(result.actions).toEqual([]);
  });

  it('handles provider with no config block', () => {
    const result = transformConfigReviewer({ 'claude-code': {} });
    expect((result.value as { tiers: Record<string, { config: unknown }> }).tiers['claude-code'].config).toEqual({});
  });

  it('STOPS when multiple providers present without active', () => {
    const result = transformConfigReviewer({
      consensus: 1,
      anthropic: { model: 'claude-3-haiku-20240307' },
      ollama: { model: 'qwen3' },
    });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/multiple providers/);
    expect(result.warnings[0]).toMatch(/reviewer\.active/);
  });

  it('STOPS when active references unknown provider', () => {
    const result = transformConfigReviewer({
      active: 'openai',
      ollama: { model: 'q' },
    });
    expect(result.value).toBeUndefined();
    expect(result.warnings[0]).toMatch(/no matching provider section/);
  });

  it('STOPS when active is not a string', () => {
    const result = transformConfigReviewer({
      active: 42 as unknown as string,
      ollama: { model: 'q' },
    });
    expect(result.value).toBeUndefined();
    expect(result.warnings[0]).toMatch(/reviewer\.active is not a string/);
  });

  it('STOPS when global consensus is even (2) — withholds migration and version bump', () => {
    const result = transformConfigReviewer({
      consensus: 2,
      ollama: { model: 'qwen3' },
    });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/reviewer\.consensus/);
    expect(result.warnings[0]).toMatch(/2/);
    expect(result.warnings[0]).toMatch(/even/);
    expect(result.warnings[0]).toMatch(/odd/);
    expect(result.warnings[0]).toMatch(/yg init --upgrade/);
  });

  it('STOPS when global consensus is even (4) — withholds migration and version bump', () => {
    const result = transformConfigReviewer({
      consensus: 4,
      ollama: { model: 'qwen3' },
    });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/4/);
  });

  it('STOPS when global consensus is less than 1 (zero) — withholds migration', () => {
    const result = transformConfigReviewer({
      consensus: 0,
      ollama: { model: 'qwen3' },
    });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings.length).toBe(1);
  });

  it('STOPS when global consensus is a non-integer (1.5) — withholds migration', () => {
    const result = transformConfigReviewer({
      consensus: 1.5,
      ollama: { model: 'qwen3' },
    });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings.length).toBe(1);
  });

  it('migrates normally when global consensus is odd (3)', () => {
    const result = transformConfigReviewer({
      consensus: 3,
      ollama: { model: 'qwen3' },
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.value).toEqual({
      tiers: {
        ollama: {
          provider: 'ollama',
          consensus: 3,
          config: { model: 'qwen3' },
        },
      },
    });
  });

  it('migrates normally when global consensus is 1 (odd baseline)', () => {
    const result = transformConfigReviewer({
      consensus: 1,
      ollama: { model: 'qwen3' },
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((result.value as { tiers: Record<string, { consensus: number }> }).tiers.ollama.consensus).toBe(1);
  });

  it('migrates normally when global consensus is absent (defaults to 1)', () => {
    const result = transformConfigReviewer({
      ollama: { model: 'qwen3' },
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((result.value as { tiers: Record<string, { consensus: number }> }).tiers.ollama.consensus).toBe(1);
  });
});

// ── transformAspectReviewer unit tests ──────────────────────

describe('transformAspectReviewer', () => {
  it('returns undefined when reviewer already mapping with type', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: { type: 'llm' } });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('treats absent reviewer as { type: llm }', () => {
    const result = transformAspectReviewer({ name: 'X' });
    expect(result.value).toEqual({ name: 'X', reviewer: { type: 'llm' } });
    expect(result.changed).toBe(true);
  });

  it('treats null reviewer as { type: llm }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: null });
    expect(result.value).toEqual({ name: 'X', reviewer: { type: 'llm' } });
    expect(result.changed).toBe(true);
  });

  it('maps "llm" string to { type: llm }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'llm' });
    expect(result.value?.reviewer).toEqual({ type: 'llm' });
  });

  it('maps "ast" string to { type: ast }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'ast' });
    expect(result.value?.reviewer).toEqual({ type: 'ast' });
  });

  it('WARNS and leaves file unchanged for unknown string', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'claude-code' });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toMatch(/unrecognized reviewer value/);
  });

  it('WARNS and leaves file unchanged when reviewer mapping has no type', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: { tier: 'deep' } });
    expect(result.value).toBeUndefined();
    expect(result.warnings[0]).toMatch(/no `type:` key/);
  });

  it('preserves other fields when transforming', () => {
    const result = transformAspectReviewer({ name: 'Test', description: 'desc', reviewer: 'llm' });
    expect(result.value?.name).toBe('Test');
    expect(result.value?.description).toBe('desc');
  });

  it('WARNS and leaves file unchanged when reviewer is an array', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: ['llm'] });
    expect(result.value).toBeUndefined();
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toMatch(/unexpected value/);
  });

  it('WARNS and leaves file unchanged when reviewer is a number', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 42 as unknown as string });
    expect(result.value).toBeUndefined();
    expect(result.warnings[0]).toMatch(/unexpected value/);
  });
});

// ── migrateTo50 integration tests ───────────────────────────

describe('migrateTo50', () => {
  it('migrates legacy single-provider config to tier named after provider', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n    temperature: 0.0\n',
    });
    const result = await migrateTo50(ygg);
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')) as {
      reviewer: { tiers: Record<string, { provider: string; consensus: number; config: { model: string } }> };
    };
    expect(Object.keys(updated.reviewer.tiers)).toEqual(['ollama']);
    expect(updated.reviewer.tiers.ollama.provider).toBe('ollama');
    expect(updated.reviewer.tiers.ollama.consensus).toBe(1);
    expect(updated.reviewer.tiers.ollama.config.model).toBe('qwen3');
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('migrates aspects with string reviewer', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: {
        'my-rule': 'name: My Rule\nreviewer: llm\n',
        'ast-rule': 'name: AST Rule\nreviewer: ast\nlanguage:\n  - typescript\n',
      },
    });
    await migrateTo50(ygg);
    const llm = parseYaml(await readFile(path.join(ygg, 'aspects/my-rule/yg-aspect.yaml'), 'utf-8')) as { reviewer: { type: string } };
    const ast = parseYaml(await readFile(path.join(ygg, 'aspects/ast-rule/yg-aspect.yaml'), 'utf-8')) as { reviewer: { type: string } };
    expect(llm.reviewer).toEqual({ type: 'llm' });
    expect(ast.reviewer).toEqual({ type: 'ast' });
  });

  it('migrates aspect with absent reviewer to { type: llm }', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: { 'no-reviewer': 'name: No Reviewer\ndescription: x\n' },
    });
    await migrateTo50(ygg);
    const updated = parseYaml(await readFile(path.join(ygg, 'aspects/no-reviewer/yg-aspect.yaml'), 'utf-8')) as { reviewer: { type: string } };
    expect(updated.reviewer).toEqual({ type: 'llm' });
  });

  it('skips aspects already in mapping form (idempotent)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: {
        'already-mapping': 'name: Mapping Rule\nreviewer:\n  type: llm\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.actions.filter(a => a.includes('yg-aspect.yaml'))).toHaveLength(0);
  });

  it('is idempotent when run twice on config', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
    });
    await migrateTo50(ygg);
    const result2 = await migrateTo50(ygg);
    expect(result2.actions.filter(a => a.includes('tier-based shape'))).toHaveLength(0);
  });

  it('STOPS when global reviewer.consensus is even — config NOT written, version NOT bumped, aspects NOT touched', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 2\n  ollama:\n    model: qwen3\n',
      aspects: { 'r1': 'name: R\nreviewer: llm\n' },
    });
    const before = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    const aspectBefore = await readFile(path.join(ygg, 'aspects/r1/yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('reviewer.consensus') && w.includes('even'))).toBe(true);

    // Config must NOT be rewritten
    expect(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')).toBe(before);
    // Aspect must NOT be touched
    expect(await readFile(path.join(ygg, 'aspects/r1/yg-aspect.yaml'), 'utf-8')).toBe(aspectBefore);
  });

  it('STOPS when global reviewer.consensus is 4 (even) — bumpVersion false', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 4\n  ollama:\n    model: qwen3\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('4') && w.includes('odd'))).toBe(true);
  });

  it('migrates normally when global reviewer.consensus is 3 (odd) — no consensus warning', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 3\n  ollama:\n    model: qwen3\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')) as {
      reviewer: { tiers: Record<string, { consensus: number }> };
    };
    expect(updated.reviewer.tiers.ollama.consensus).toBe(3);
  });

  it('STOPS migration when multiple providers without active — config rewritten, version not bumped, aspects not touched', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  ollama:\n    model: qwen3\n  anthropic:\n    model: claude-3\n',
      aspects: { 'r1': 'name: R\nreviewer: llm\n' },
    });
    const before = await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8');
    const aspectBefore = await readFile(path.join(ygg, 'aspects/r1/yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('multiple providers'))).toBe(true);

    // Config not rewritten
    expect(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')).toBe(before);
    // Aspect not touched
    expect(await readFile(path.join(ygg, 'aspects/r1/yg-aspect.yaml'), 'utf-8')).toBe(aspectBefore);
  });

  it('does NOT bump version when an aspect has an unrecognized reviewer string', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: { 'bad': 'name: Bad\nreviewer: claude-code\n' },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('unrecognized reviewer value'))).toBe(true);
  });

  it('does NOT bump version when an aspect reviewer mapping lacks type', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: { 'no-type': 'name: No Type\nreviewer:\n  tier: deep\n' },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('no `type:` key'))).toBe(true);
  });

  it('flags secrets file with non-credential fields and withholds version bump', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      secrets: 'reviewer:\n  anthropic:\n    api_key: sk-1\n    model: shouldnt-be-here\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('yg-secrets.yaml'))).toBe(true);
    expect(result.warnings.some(w => w.includes('non-credential fields'))).toBe(true);
  });

  it('passes silently for secrets file with api_key only', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      secrets: 'reviewer:\n  anthropic:\n    api_key: sk-1\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns when no yg-config.yaml — version is not bumped', async () => {
    const ygg = await setupYgg({});
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('not found'))).toBe(true);
  });

  it('warns when yg-config.yaml is unparseable YAML', async () => {
    const ygg = await setupYgg({ config: ': not: [valid yaml\n' });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('parse error'))).toBe(true);
  });

  it('warns when yg-config.yaml top-level is not a mapping (scalar)', async () => {
    const ygg = await setupYgg({ config: '42\n' });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('not a YAML mapping'))).toBe(true);
  });

  it('warns and leaves aspect untouched when YAML is invalid', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: { 'bad-yaml': ': invalid: [unclosed\n' },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.some(w => w.includes('parse error'))).toBe(true);
    expect(result.bumpVersion).toBe(false);
  });

  it('skips aspect dir that has no yg-aspect.yaml (non-file entry)', async () => {
    const ygg = await setupYgg({ config: 'version: "4.3.0"\n' });
    const emptyAspectDir = path.join(ygg, 'aspects', 'empty-dir');
    await mkdir(emptyAspectDir, { recursive: true });
    const result = await migrateTo50(ygg);
    expect(result.actions.filter(a => a.includes('yg-aspect.yaml'))).toHaveLength(0);
  });

  it('skips config migration when reviewer is already tier-shaped', async () => {
    const ygg = await setupYgg({
      config: 'version: "5.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: qwen3\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.actions.filter(a => a.includes('tier-based shape'))).toHaveLength(0);
    expect(result.bumpVersion).toBe(true);
  });

  // ── addAspectStatusDefaults pass ───────────────────────────

  it('aspect-status pass: absent status field → no rewrite, no warning, bumpVersion stays true', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\nimplies:\n  - b\n',
        'b': 'name: B\nreviewer:\n  type: llm\n',
      },
    });
    const aspectABefore = await readFile(path.join(ygg, 'aspects/a/yg-aspect.yaml'), 'utf-8');
    const aspectBBefore = await readFile(path.join(ygg, 'aspects/b/yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(ygg);

    // No status-related warning, both aspects default to 'enforced' on both sides.
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
    expect(result.bumpVersion).toBe(true);
    // Files unchanged in content (no rewrites from this pass).
    expect(await readFile(path.join(ygg, 'aspects/a/yg-aspect.yaml'), 'utf-8')).toBe(aspectABefore);
    expect(await readFile(path.join(ygg, 'aspects/b/yg-aspect.yaml'), 'utf-8')).toBe(aspectBBefore);
  });

  it('aspect-status pass: implies escalation (A enforced bare-implies B advisory) → emits escalation warning, bumpVersion false', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a-strict': 'name: A\nreviewer:\n  type: llm\nimplies:\n  - b-soft\n',
        'b-soft': 'name: B\nreviewer:\n  type: llm\nstatus: advisory\n',
      },
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - a-strict\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    const escalation = result.warnings.find(w => w.includes('aspect-status-migration-escalation'));
    expect(escalation).toBeDefined();
    expect(escalation).toMatch(/a-strict/);
    expect(escalation).toMatch(/b-soft/);
    expect(escalation).toMatch(/advisory/);
    expect(escalation).toMatch(/1 node aspect/); // 1 direct attach
  });

  it('aspect-status pass: status_inherit: own-default on the escalation edge → NO escalation warning', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a-strict': 'name: A\nreviewer:\n  type: llm\nimplies:\n  - id: b-soft\n    status_inherit: own-default\n',
        'b-soft': 'name: B\nreviewer:\n  type: llm\nstatus: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration-escalation'))).toEqual([]);
    expect(result.bumpVersion).toBe(true);
  });

  it('aspect-status pass: architecture node-type attach with downgraded status → emits downgrade warning', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n', // default enforced
      },
      architecture: 'node_types:\n  command:\n    description: A command type.\n    aspects:\n      - id: a\n        status: advisory\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    const downgrade = result.warnings.find(w => w.includes('aspect-status-migration-downgrade'));
    expect(downgrade).toBeDefined();
    expect(downgrade).toMatch(/yg-architecture\.yaml/);
    expect(downgrade).toMatch(/node_type: command/);
  });

  it('aspect-status pass: flow attach with downgraded status → emits downgrade warning', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n', // default enforced
      },
      flows: {
        'checkout': 'name: checkout\nnodes: []\naspects:\n  - id: a\n    status: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    const downgrade = result.warnings.find(w => w.includes('aspect-status-migration-downgrade'));
    expect(downgrade).toBeDefined();
    expect(downgrade).toMatch(/flows\/checkout\/yg-flow\.yaml/);
  });

  it('aspect-status pass: port attach contributes to channels and does not raise spurious warnings', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\nstatus: advisory\n',
      },
      nodes: {
        'payments': 'name: payments\ntype: module\nports:\n  charge:\n    aspects:\n      - id: a\n        status: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    // Aspect a default is advisory; site declared advisory → not below anchor → no warning.
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
    expect(result.bumpVersion).toBe(true);
  });

  it('aspect-status pass: implied aspect with draft default (not advisory) also triggers escalation', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a-strict': 'name: A\nreviewer:\n  type: llm\nimplies:\n  - b-draft\n',
        'b-draft': 'name: B\nreviewer:\n  type: llm\nstatus: draft\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    const escalation = result.warnings.find(w => w.includes('aspect-status-migration-escalation'));
    expect(escalation).toBeDefined();
    expect(escalation).toMatch(/draft/);
  });

  it('aspect-status pass: implier with advisory default does NOT trigger escalation (only enforced impliers do)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\nstatus: advisory\nimplies:\n  - b\n',
        'b': 'name: B\nreviewer:\n  type: llm\nstatus: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration-escalation'))).toEqual([]);
    expect(result.bumpVersion).toBe(true);
  });

  it('aspect-status pass: skips when no aspects directory exists', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: tolerates broken node YAML (skips that node, no crash)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      nodes: {
        'bad': ': not: [valid\n',
        'good': 'name: good\ntype: module\naspects:\n  - a\n',
      },
    });
    const result = await migrateTo50(ygg);
    // Broken node parsed-warning is not produced by this pass; bad YAML is silently skipped.
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: tolerates broken flow YAML (skips that flow, no crash)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      flows: {
        'broken': ': not: [valid\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: explicit status equal to anchor → NO downgrade warning', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n', // default enforced
      },
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - id: a\n    status: enforced\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
    expect(result.bumpVersion).toBe(true);
  });

  it('aspect-status pass: multiple sites for the same aspect — anchor includes the higher OTHER channel', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        // Aspect default draft (so aspectDefault alone is not the anchor).
        'a': 'name: A\nreviewer:\n  type: llm\nstatus: draft\n',
      },
      nodes: {
        // Node 1 declares enforced (raises anchor for node 2's site).
        'high': 'name: high\ntype: module\naspects:\n  - id: a\n    status: enforced\n',
        // Node 2 declares draft — strictly below the enforced anchor from node 1.
        'low': 'name: low\ntype: module\naspects:\n  - id: a\n    status: draft\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    // The 'low' site is below the cross-channel anchor 'enforced' from 'high'.
    expect(result.warnings.some(w => w.includes('aspect-status-migration-downgrade') && w.includes('low'))).toBe(true);
  });

  it('aspect-status pass: ignores aspects with invalid YAML (treats as missing aspect)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'bad': ': not: [valid yaml\n',
      },
    });
    const result = await migrateTo50(ygg);
    // The aspect parser pass already produces a parse-error warning; status pass adds nothing.
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: ignores empty-string and null aspect attachment entries', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - ""\n  - null\n  - a\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: ignores object aspect attachment without id', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - status: advisory\n  - a\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: ignores port objects with non-array aspects', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      nodes: {
        'payments': 'name: payments\ntype: module\nports:\n  charge:\n    description: x\n  refund: not-an-object\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: ignores non-mapping aspect YAML (top-level array)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'arr': '- not\n- a mapping\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: implies entry with empty string is ignored', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\nimplies:\n  - ""\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: ignores non-string/non-object aspect attachment entries (e.g. numbers)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      // Use a malformed entry in implies (a number) — should be silently ignored by the status pass.
      // (Aspect parser will warn separately during full validation.)
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - 42\n  - a\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration'))).toEqual([]);
  });

  it('aspect-status pass: draft anchor (no enforced cascade) — advisory site does NOT trigger downgrade', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        // Aspect default draft; one site declares advisory — that's a raise, not a downgrade.
        'a': 'name: A\nreviewer:\n  type: llm\nstatus: draft\n',
      },
      nodes: {
        'orders': 'name: orders\ntype: module\naspects:\n  - id: a\n    status: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.filter(w => w.includes('aspect-status-migration-downgrade'))).toEqual([]);
  });

  it('aspect-status pass: explicit downgrade (node attaches enforced-default aspect with status: advisory) → emits downgrade warning, bumpVersion false', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: q\n',
      aspects: {
        // Aspect a — default 'enforced' (status unset).
        'a': 'name: A\nreviewer:\n  type: llm\n',
      },
      nodes: {
        // Node explicitly sets status: advisory on aspect a — strictly below the aspect-default anchor (enforced).
        'orders': 'name: orders\ntype: module\naspects:\n  - id: a\n    status: advisory\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    const downgrade = result.warnings.find(w => w.includes('aspect-status-migration-downgrade'));
    expect(downgrade).toBeDefined();
    expect(downgrade).toMatch(/orders/);
    expect(downgrade).toMatch(/aspect 'a'/);
    expect(downgrade).toMatch(/advisory/);
    expect(downgrade).toMatch(/enforced/);
  });
});
