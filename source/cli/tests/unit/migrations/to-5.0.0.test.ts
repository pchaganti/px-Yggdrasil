import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { migrateTo50, transformConfigReviewer, transformAspectReviewer } from '../../../src/migrations/to-5.0.0.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setupYgg(opts: {
  config?: string;
  aspects?: Record<string, string>;
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
  return ygg;
}

// ── transformConfigReviewer unit tests ──────────────────────

describe('transformConfigReviewer', () => {
  it('returns undefined when already v5 (has tiers)', () => {
    const result = transformConfigReviewer({ tiers: {} });
    expect(result).toBeUndefined();
  });

  it('returns undefined when already v5 (has default key)', () => {
    const result = transformConfigReviewer({ default: {} });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no provider keys and no active', () => {
    const result = transformConfigReviewer({ someUnknown: 'val' });
    expect(result).toBeUndefined();
  });

  it('transforms single provider (no active key)', () => {
    const result = transformConfigReviewer({
      consensus: 1,
      ollama: { model: 'qwen3', temperature: 0.1 },
    });
    expect(result).toEqual({
      tiers: {
        standard: {
          provider: 'ollama',
          consensus: 1,
          config: { model: 'qwen3', temperature: 0.1 },
        },
      },
    });
  });

  it('transforms with explicit active key', () => {
    const result = transformConfigReviewer({
      active: 'claude-code',
      consensus: 3,
      ollama: { model: 'qwen3' },
      'claude-code': { model: 'haiku' },
    });
    expect(result?.tiers).toHaveProperty('standard');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result?.tiers as any).standard.provider).toBe('claude-code');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result?.tiers as any).standard.consensus).toBe(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result?.tiers as any).standard.config).toEqual({ model: 'haiku' });
  });

  it('defaults consensus to 1 when missing', () => {
    const result = transformConfigReviewer({ ollama: { model: 'x' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result?.tiers as any).standard.consensus).toBe(1);
  });

  it('handles provider with no config block', () => {
    const result = transformConfigReviewer({ 'claude-code': {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result?.tiers as any).standard.config).toEqual({});
  });

  it('picks first provider when multiple present with no active key', () => {
    const result = transformConfigReviewer({
      consensus: 1,
      anthropic: { model: 'claude-3-haiku-20240307' },
      ollama: { model: 'qwen3' },
    });
    expect(result).not.toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tier = (result?.tiers as any).standard;
    expect(['anthropic', 'ollama']).toContain(tier.provider);
  });
});

// ── transformAspectReviewer unit tests ──────────────────────

describe('transformAspectReviewer', () => {
  it('returns undefined when reviewer is already object form', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: { type: 'llm' } });
    expect(result).toBeUndefined();
  });

  it('returns undefined when reviewer is absent', () => {
    const result = transformAspectReviewer({ name: 'X' });
    expect(result).toBeUndefined();
  });

  it('maps "llm" string to { type: llm }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'llm' });
    expect(result?.reviewer).toEqual({ type: 'llm' });
  });

  it('maps "ast" string to { type: ast }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'ast' });
    expect(result?.reviewer).toEqual({ type: 'ast' });
  });

  it('maps provider name string to { type: llm }', () => {
    const result = transformAspectReviewer({ name: 'X', reviewer: 'claude-code' });
    expect(result?.reviewer).toEqual({ type: 'llm' });
  });

  it('preserves other fields', () => {
    const result = transformAspectReviewer({ name: 'Test', description: 'desc', reviewer: 'llm' });
    expect(result?.name).toBe('Test');
    expect(result?.description).toBe('desc');
  });
});

// ── migrateTo50 integration tests ───────────────────────────

describe('migrateTo50', () => {
  it('migrates v4 config single-provider to v5 tiers', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n    temperature: 0.0\n',
    });
    const result = await migrateTo50(ygg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')) as any;
    expect(updated.reviewer.tiers.standard.provider).toBe('ollama');
    expect(updated.reviewer.tiers.standard.consensus).toBe(1);
    expect(updated.reviewer.tiers.standard.config.model).toBe('qwen3');
    expect(updated.version).toBe('5.0.0');
    expect(result.actions.some(a => a.includes('tiers'))).toBe(true);
    expect(result.actions.some(a => a.includes('5.0.0'))).toBe(true);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llm = parseYaml(await readFile(path.join(ygg, 'aspects/my-rule/yg-aspect.yaml'), 'utf-8')) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ast = parseYaml(await readFile(path.join(ygg, 'aspects/ast-rule/yg-aspect.yaml'), 'utf-8')) as any;
    expect(llm.reviewer).toEqual({ type: 'llm' });
    expect(ast.reviewer).toEqual({ type: 'ast' });
  });

  it('skips aspects already in object form (idempotent)', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: {
        'already-v5': 'name: V5 Rule\nreviewer:\n  type: llm\n',
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
    // Second run: reviewer already v5 → no config action
    expect(result2.actions.filter(a => a.includes('tiers'))).toHaveLength(0);
  });

  it('warns when no yg-config.yaml', async () => {
    const ygg = await setupYgg({});
    const result = await migrateTo50(ygg);
    expect(result.warnings.some(w => w.includes('not found'))).toBe(true);
  });

  it('warns for multiple providers and picks first', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\nreviewer:\n  active: ollama\n  consensus: 1\n  ollama:\n    model: qwen3\n  anthropic:\n    model: claude-3-haiku-20240307\n',
    });
    const result = await migrateTo50(ygg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = parseYaml(await readFile(path.join(ygg, 'yg-config.yaml'), 'utf-8')) as any;
    expect(updated.reviewer.tiers.standard.provider).toBe('ollama');
    expect(result.warnings.some(w => w.includes('multiple providers') || w.includes('5.0.0'))).toBe(true);
  });

  it('skips aspect dir that has no yg-aspect.yaml (non-file entry)', async () => {
    const ygg = await setupYgg({ config: 'version: "4.3.0"\n' });
    // Create a subdirectory under aspects/ with no yg-aspect.yaml
    const emptyAspectDir = path.join(ygg, 'aspects', 'empty-dir');
    await mkdir(emptyAspectDir, { recursive: true });
    const result = await migrateTo50(ygg);
    // No aspect actions — the missing file is silently skipped
    expect(result.actions.filter(a => a.includes('yg-aspect.yaml'))).toHaveLength(0);
  });

  it('warns and skips aspect with invalid YAML', async () => {
    const ygg = await setupYgg({
      config: 'version: "4.3.0"\n',
      aspects: {
        'bad-yaml': ': invalid: [unclosed\n',
      },
    });
    const result = await migrateTo50(ygg);
    expect(result.warnings.some(w => w.includes('parse error'))).toBe(true);
  });

  it('warns when updateConfigVersion fails (no config but aspect migrated)', async () => {
    // Only aspects dir, no yg-config.yaml — updateConfigVersion will throw
    const ygg = await setupYgg({
      aspects: { 'my-rule': 'name: My Rule\nreviewer: llm\n' },
    });
    const result = await migrateTo50(ygg);
    // Aspect was migrated (action recorded), then version bump fails → warning
    expect(result.actions.some(a => a.includes('yg-aspect.yaml'))).toBe(true);
    expect(result.warnings.some(w => w.includes('not updated') || w.includes('not found'))).toBe(true);
  });

  it('skips config migration when reviewer is already v5', async () => {
    const ygg = await setupYgg({
      config: 'version: "5.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: qwen3\n',
    });
    const result = await migrateTo50(ygg);
    expect(result.actions.filter(a => a.includes('tiers'))).toHaveLength(0);
  });
});
