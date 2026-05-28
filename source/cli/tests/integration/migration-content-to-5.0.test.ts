import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateTo50 } from '../../src/migrations/to-5.0.0.js';

// ── Realistic v4.3 → v5.0 content test ────────────────────────
//
// Reference shape pulled from the v4.3 schema (`graph-schemas/yg-*.yaml`
// before the v5 rewrite) and the legacy reviewer protocol:
//   - yg-config.yaml reviewer block uses `active: <provider>`, a global
//     `consensus:` int, and provider-keyed nested mappings
//     (`reviewer.ollama: { model, endpoint, ... }`).
//   - yg-aspect.yaml uses scalar `reviewer: llm | ast` (or omits the
//     field, defaulting to llm).
//   - yg-secrets.yaml may contain per-provider blocks; only `api_key`
//     is a credential — anything else is a v4 leftover.
//   - Aspects can nest in subdirectories (e.g. `aspects/group/inner/`).

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedV43Repo(opts: {
  config: string;
  aspects?: Record<string, string>;
  nestedAspects?: Record<string, string>;
  secrets?: string;
} = { config: 'version: "4.3.0"\n' }): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-mig-v43-'));
  dirsToCleanup.push(root);
  const ygg = join(root, '.yggdrasil');
  mkdirSync(ygg, { recursive: true });
  writeFileSync(join(ygg, 'yg-config.yaml'), opts.config);
  if (opts.aspects) {
    for (const [id, yaml] of Object.entries(opts.aspects)) {
      const dir = join(ygg, 'aspects', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'yg-aspect.yaml'), yaml);
    }
  }
  if (opts.nestedAspects) {
    for (const [path, yaml] of Object.entries(opts.nestedAspects)) {
      const dir = join(ygg, 'aspects', ...path.split('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'yg-aspect.yaml'), yaml);
    }
  }
  if (opts.secrets !== undefined) {
    writeFileSync(join(ygg, 'yg-secrets.yaml'), opts.secrets);
  }
  return ygg;
}

function readYaml(filePath: string): Record<string, unknown> {
  return parseYaml(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

describe('to-5.0.0 — realistic v4.3 → v5 content transformation (config)', () => {
  it('single-provider legacy block becomes a single tier named after the provider; no default key', async () => {
    const ygg = seedV43Repo({
      config: [
        'version: "4.3.0"',
        'parallel: 10',
        'reviewer:',
        '  consensus: 1',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '    temperature: 0',
        '    max_tokens: auto',
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);

    const cfg = readYaml(join(ygg, 'yg-config.yaml'));
    const reviewer = cfg.reviewer as Record<string, unknown>;
    expect(reviewer).not.toHaveProperty('active');
    expect(reviewer).not.toHaveProperty('consensus');
    expect(reviewer).not.toHaveProperty('default');

    const tiers = reviewer.tiers as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers)).toEqual(['ollama']);
    expect(tiers.ollama.provider).toBe('ollama');
    expect(tiers.ollama.consensus).toBe(1);
    expect(tiers.ollama.config).toEqual({
      model: 'qwen3',
      endpoint: 'http://localhost:11434',
      temperature: 0,
      max_tokens: 'auto',
    });

    // Top-level fields preserved.
    expect(cfg.parallel).toBe(10);
  });

  it('multi-provider with active becomes named tiers + default; global consensus copies into every tier', async () => {
    const ygg = seedV43Repo({
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  active: anthropic',
        '  consensus: 3',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '  anthropic:',
        '    model: claude-opus-4-7',
        '    temperature: 0',
        '  openai:',
        '    model: gpt-4o',
        '    temperature: 0.2',
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);

    const reviewer = readYaml(join(ygg, 'yg-config.yaml')).reviewer as Record<string, unknown>;
    expect(reviewer.default).toBe('anthropic');
    const tiers = reviewer.tiers as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers).sort()).toEqual(['anthropic', 'ollama', 'openai']);
    expect(tiers.ollama.provider).toBe('ollama');
    expect(tiers.anthropic.provider).toBe('anthropic');
    expect(tiers.openai.provider).toBe('openai');
    // Consensus carried into EVERY tier.
    expect(tiers.ollama.consensus).toBe(3);
    expect(tiers.anthropic.consensus).toBe(3);
    expect(tiers.openai.consensus).toBe(3);
    // Provider configs preserved verbatim.
    expect(tiers.ollama.config).toEqual({ model: 'qwen3', endpoint: 'http://localhost:11434' });
    expect(tiers.anthropic.config).toEqual({ model: 'claude-opus-4-7', temperature: 0 });
    expect(tiers.openai.config).toEqual({ model: 'gpt-4o', temperature: 0.2 });

    // Advisory action announces the inherited consensus.
    expect(result.actions.some((a) => a.includes('consensus 3 copied into every tier'))).toBe(true);
  });

  it('multi-provider WITHOUT active stops migration; config and aspects unchanged; no version bump', async () => {
    const ygg = seedV43Repo({
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '  anthropic:',
        '    model: claude-opus-4-7',
      ].join('\n') + '\n',
      aspects: {
        legacy: 'name: Legacy\nreviewer: llm\n',
      },
    });

    const configBefore = readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8');
    const aspectBefore = readFileSync(join(ygg, 'aspects', 'legacy', 'yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(ygg);

    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some((w) => w.includes('multiple providers'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('reviewer.active'))).toBe(true);

    // Config NOT rewritten.
    expect(readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8')).toBe(configBefore);
    // Aspects NOT touched — STOP-before-aspects guard held.
    expect(readFileSync(join(ygg, 'aspects', 'legacy', 'yg-aspect.yaml'), 'utf-8')).toBe(aspectBefore);
  });

  it('stops when reviewer.active references a provider that has no section', async () => {
    const ygg = seedV43Repo({
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  active: openai',
        '  ollama:',
        '    model: qwen3',
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some((w) => w.includes("'openai'") && w.includes('no matching provider section'))).toBe(true);
  });

  it('config that is already tier-shaped is a no-op (idempotent)', async () => {
    const v5Config = [
      'version: "5.0.0"',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      consensus: 1',
      '      config:',
      '        model: qwen3',
    ].join('\n') + '\n';
    const ygg = seedV43Repo({ config: v5Config });

    const before = readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8');
    const result = await migrateTo50(ygg);

    expect(readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8')).toBe(before);
    expect(result.actions.some((a) => a.includes('migrated reviewer'))).toBe(false);
    expect(result.bumpVersion).toBe(true);
  });
});

describe('to-5.0.0 — realistic v4.3 → v5 content transformation (aspects)', () => {
  it('scalar reviewer values become mapping form', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: {
        'requires-logging': 'name: Logging\nreviewer: llm\n',
        'no-sync-io': 'name: NoSyncIO\nreviewer: ast\nlanguage:\n  - typescript\n',
      },
    });

    await migrateTo50(ygg);

    const logging = readYaml(join(ygg, 'aspects', 'requires-logging', 'yg-aspect.yaml'));
    expect(logging.reviewer).toEqual({ type: 'llm' });
    const ast = readYaml(join(ygg, 'aspects', 'no-sync-io', 'yg-aspect.yaml'));
    expect(ast.reviewer).toEqual({ type: 'ast' });
    expect(ast.language).toEqual(['typescript']);
  });

  it('absent reviewer field is treated as { type: llm }', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: { defaulted: 'name: Defaulted\ndescription: "no reviewer field"\n' },
    });

    await migrateTo50(ygg);

    const a = readYaml(join(ygg, 'aspects', 'defaulted', 'yg-aspect.yaml'));
    expect(a.reviewer).toEqual({ type: 'llm' });
    // Other fields preserved.
    expect(a.name).toBe('Defaulted');
    expect(a.description).toBe('no reviewer field');
  });

  it('null reviewer field is treated as { type: llm }', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: { nilled: 'name: Nilled\nreviewer: null\n' },
    });

    await migrateTo50(ygg);
    const a = readYaml(join(ygg, 'aspects', 'nilled', 'yg-aspect.yaml'));
    expect(a.reviewer).toEqual({ type: 'llm' });
  });

  it('unrecognized reviewer string emits a warning and leaves the file untouched; chain stops', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: { bad: 'name: Bad\nreviewer: claude-code\n' },
    });

    const before = readFileSync(join(ygg, 'aspects', 'bad', 'yg-aspect.yaml'), 'utf-8');
    const result = await migrateTo50(ygg);

    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some((w) =>
      w.includes("aspects/bad/yg-aspect.yaml") &&
      w.includes('unrecognized reviewer value') &&
      w.includes("'claude-code'")
    )).toBe(true);
    expect(readFileSync(join(ygg, 'aspects', 'bad', 'yg-aspect.yaml'), 'utf-8')).toBe(before);
  });

  it('mapping reviewer without a type key emits a warning; file untouched', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: {
        'no-type': 'name: NoType\nreviewer:\n  tier: deep\n',
      },
    });

    const before = readFileSync(join(ygg, 'aspects', 'no-type', 'yg-aspect.yaml'), 'utf-8');
    const result = await migrateTo50(ygg);

    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some((w) =>
      w.includes('aspects/no-type/yg-aspect.yaml') &&
      w.includes('no `type:` key')
    )).toBe(true);
    expect(readFileSync(join(ygg, 'aspects', 'no-type', 'yg-aspect.yaml'), 'utf-8')).toBe(before);
  });

  it('mapping reviewer that already declares { type: ... } is idempotent', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: {
        v5: 'name: V5\nreviewer:\n  type: llm\n  tier: deep\n',
      },
    });

    const before = readFileSync(join(ygg, 'aspects', 'v5', 'yg-aspect.yaml'), 'utf-8');
    const result = await migrateTo50(ygg);

    expect(readFileSync(join(ygg, 'aspects', 'v5', 'yg-aspect.yaml'), 'utf-8')).toBe(before);
    expect(result.actions.filter((a) => a.includes('aspects/v5'))).toHaveLength(0);
  });

  it('warns and skips aspects whose YAML cannot be parsed', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      aspects: { broken: ': not: [valid\n' },
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some((w) => w.includes('aspects/broken/yg-aspect.yaml') && w.includes('parse error'))).toBe(true);
  });

  it('recurses into nested aspect directories', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      nestedAspects: {
        'group/inner': 'name: Inner\nreviewer: llm\n',
        'group/deep/very-inner': 'name: VeryInner\nreviewer: ast\nlanguage:\n  - typescript\n',
      },
    });

    await migrateTo50(ygg);

    const inner = readYaml(join(ygg, 'aspects', 'group', 'inner', 'yg-aspect.yaml'));
    expect(inner.reviewer).toEqual({ type: 'llm' });
    const veryInner = readYaml(join(ygg, 'aspects', 'group', 'deep', 'very-inner', 'yg-aspect.yaml'));
    expect(veryInner.reviewer).toEqual({ type: 'ast' });
  });
});

describe('to-5.0.0 — realistic v4.3 → v5 content transformation (secrets)', () => {
  it('api_key-only secrets file passes without warnings', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      secrets: 'reviewer:\n  anthropic:\n    api_key: sk-ant-foo\n',
    });

    const result = await migrateTo50(ygg);

    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('non-credential fields trigger a warning per provider; chain stops', async () => {
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      secrets: [
        'reviewer:',
        '  anthropic:',
        '    api_key: sk-ant-foo',
        '    model: claude-opus-4-7',   // foreign field (legacy v4 override)
        '    temperature: 0',           // foreign field
        '  openai:',
        '    api_key: sk-oai-bar',
        '    endpoint: https://api.openai.com/v1',  // foreign field
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(ygg);

    expect(result.bumpVersion).toBe(false);
    const anthropicWarning = result.warnings.find((w) =>
      w.includes('yg-secrets.yaml') && w.includes("'anthropic'") && w.includes('non-credential fields'),
    );
    expect(anthropicWarning).toBeDefined();
    expect(anthropicWarning).toContain('model');
    expect(anthropicWarning).toContain('temperature');

    const openaiWarning = result.warnings.find((w) =>
      w.includes('yg-secrets.yaml') && w.includes("'openai'") && w.includes('non-credential fields'),
    );
    expect(openaiWarning).toBeDefined();
    expect(openaiWarning).toContain('endpoint');
  });

  it('secrets file is never modified by the migration (inspect-only)', async () => {
    const secretsContent = [
      'reviewer:',
      '  anthropic:',
      '    api_key: sk-ant-foo',
      '    model: claude-opus-4-7',
    ].join('\n') + '\n';
    const ygg = seedV43Repo({
      config: 'version: "4.3.0"\nreviewer:\n  consensus: 1\n  ollama:\n    model: qwen3\n',
      secrets: secretsContent,
    });

    await migrateTo50(ygg);
    expect(readFileSync(join(ygg, 'yg-secrets.yaml'), 'utf-8')).toBe(secretsContent);
  });
});

describe('to-5.0.0 — combined realistic v4.3 fixture', () => {
  it('end-to-end: a full v4.3 fixture with reviewer + multiple aspects + clean secrets lands on v5 shape', async () => {
    const ygg = seedV43Repo({
      config: [
        'version: "4.3.0"',
        'parallel: 5',
        'quality:',
        '  max_direct_relations: 10',
        'reviewer:',
        '  active: claude-code',
        '  consensus: 1',
        '  claude-code:',
        '    model: sonnet',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
      ].join('\n') + '\n',
      aspects: {
        'requires-audit': 'name: Audit\ndescription: "Audit"\nreviewer: llm\n',
        'no-sync-io': 'name: NoSyncIO\ndescription: "No sync IO"\nreviewer: ast\nlanguage:\n  - typescript\n',
      },
      nestedAspects: {
        'observability/logging': 'name: Logging\ndescription: "Logging"\nreviewer: llm\n',
      },
      secrets: 'reviewer:\n  anthropic:\n    api_key: sk-ant-foo\n',
    });

    const result = await migrateTo50(ygg);
    expect(result.bumpVersion).toBe(true);
    expect(result.warnings).toEqual([]);

    // Config shape.
    const cfg = readYaml(join(ygg, 'yg-config.yaml'));
    expect(cfg.parallel).toBe(5);
    const reviewer = cfg.reviewer as Record<string, unknown>;
    expect(reviewer.default).toBe('claude-code');
    const tiers = reviewer.tiers as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers).sort()).toEqual(['claude-code', 'ollama']);
    expect(tiers['claude-code'].provider).toBe('claude-code');
    expect(tiers.ollama.provider).toBe('ollama');

    // Aspects.
    expect(readYaml(join(ygg, 'aspects', 'requires-audit', 'yg-aspect.yaml')).reviewer).toEqual({ type: 'llm' });
    expect(readYaml(join(ygg, 'aspects', 'no-sync-io', 'yg-aspect.yaml')).reviewer).toEqual({ type: 'ast' });
    expect(readYaml(join(ygg, 'aspects', 'observability', 'logging', 'yg-aspect.yaml')).reviewer).toEqual({ type: 'llm' });

    // Secrets untouched.
    expect(existsSync(join(ygg, 'yg-secrets.yaml'))).toBe(true);
  });
});
