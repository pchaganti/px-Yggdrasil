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
});
