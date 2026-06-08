import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';
import type { YggConfig, LlmConfig } from '../../../src/model/graph.js';

/** Bridge: extract the first (and typically only) tier from the new ReviewerConfig structure */
function getLlm(config: YggConfig): LlmConfig | undefined {
  if (!config.reviewer) return undefined;
  const tiers = Object.values(config.reviewer.tiers);
  return tiers.length > 0 ? tiers[0] : undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil');
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-config') || e.startsWith('tmp-no-llm') || e.startsWith('tmp-reviewer') || e.startsWith('tmp-v5'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('config-parser', () => {
  it('parses valid yg-config.yaml correctly', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));

    expect(config.quality?.max_direct_relations).toBeDefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-empty');
    await mkdir(tmpDir, { recursive: true });
    const badConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(badConfigPath, '', 'utf-8');

    await expect(parseConfig(badConfigPath)).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses minimal config', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-minimal');
    await mkdir(tmpDir, { recursive: true });
    const minimalConfigPath = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(
      minimalConfigPath,
      `
version: "4.0.0"
`,
      'utf-8',
    );

    const config = await parseConfig(minimalConfigPath);
    expect(config.version).toBe('4.0.0');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality.max_direct_relations when present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBeDefined();
  });


  it('parses version field when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-version');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `version: "2.0.0"
`,
      'utf-8',
    );
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.version).toBe('2.0.0');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults version to undefined when not present', async () => {
    const config = await parseConfig(path.join(FIXTURE_DIR, 'yg-config.yaml'));
    expect(config.version).toBeUndefined();
  });

  it('ignores unknown config sections', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-ignores-artifacts');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
custom_section:
  key: value
  nested:
    deep: true
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.version).toBe('4.0.0');
    // unknown fields should not exist on returned config
    expect((config as Record<string, unknown>).custom_section).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses quality defaults when quality is not provided', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-no-quality');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBe(10);
    expect(config.quality?.max_node_chars).toBe(40000);

    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('quality.max_node_chars validation', () => {
    async function parseWithMaxNodeChars(value: string) {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-cfg-mnc-'));
      try {
        await writeFile(
          path.join(dir, 'yg-config.yaml'),
          `version: "4.0.0"\nquality:\n  max_node_chars: ${value}\n`,
          'utf-8',
        );
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('accepts a positive integer', async () => {
      const config = await parseWithMaxNodeChars('25000');
      expect(config.quality?.max_node_chars).toBe(25000);
    });

    for (const bad of ['0', '-5', '40000.5']) {
      it(`rejects ${bad} as not a positive integer`, async () => {
        await expect(parseWithMaxNodeChars(bad)).rejects.toThrow(ConfigParseError);
      });
    }
  });

  it('parses partial quality configuration with defaults', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-partial-quality');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'yg-config.yaml'),
      `
version: "4.0.0"
quality:
  max_direct_relations: 15
`,
      'utf-8',
    );

    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.quality?.max_direct_relations).toBe(15);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses parallel: 5', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: 5\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.parallel).toBe(5);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parallel field absent → config.parallel is undefined', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-noparallel');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.parallel).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when parallel is 0', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel-zero');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: 0\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'parallel must be a positive integer',
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when parallel is a string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-parallel-string');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nparallel: "4"\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'parallel must be a number',
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when quality is not a mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-quality-string');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\nquality: "high"\n', 'utf-8');
    await expect(parseConfig(path.join(tmpDir, 'yg-config.yaml'))).rejects.toThrow(
      'quality must be a mapping',
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses debug: true', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-debug-true');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\ndebug: true\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.debug).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('debug absent → config.debug is undefined', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-no-debug');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'yg-config.yaml'), 'version: "4.0.0"\n', 'utf-8');
    const config = await parseConfig(path.join(tmpDir, 'yg-config.yaml'));
    expect(config.debug).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts config without reviewer section', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-no-llm-config');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(
        configPath,
        `
version: "4.0.0"
`,
        'utf-8',
      );

      const config = await parseConfig(configPath);
      expect(getLlm(config)).toBeUndefined();

      await rm(tmpDir, { recursive: true, force: true });
    });

  describe('parseConfig v5 happy paths', () => {
    it('minimal v5 config with one tier', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-minimal');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config:
        model: sonnet
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.standard).toBeDefined();
      expect(cfg.reviewer?.tiers.standard.provider).toBe('claude-code');
      expect(cfg.reviewer?.tiers.standard.model).toBe('sonnet');
    });

    it('v5 with default and multiple tiers', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-multi-tiers');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  default: deep
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config: { model: sonnet }
    deep:
      provider: claude-code
      consensus: 3
      config: { model: opus }
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.default).toBe('deep');
      expect(cfg.reviewer?.tiers.standard).toBeDefined();
      expect(cfg.reviewer?.tiers.deep).toBeDefined();
      expect(cfg.reviewer?.tiers.standard.consensus).toBe(1);
      expect(cfg.reviewer?.tiers.deep.consensus).toBe(3);
    });

    it('v5 single tier with temperature (max_tokens no longer a recognized field — silently ignored)', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-ollama-tier');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    main:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        temperature: 0.2
        max_tokens: 4096
`, 'utf-8');

      // max_tokens is now a removed field — silently ignored; temperature still parses
      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.main.temperature).toBe(0.2);
      expect((cfg.reviewer?.tiers.main as unknown as Record<string, unknown>)['max_tokens']).toBeUndefined();
    });

    it('v5 model defaults — claude-code without explicit model in config', async () => {
      const tmpDir = path.join(FIXTURES_DIR, 'tmp-v5-provider-defaults');
      await mkdir(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'yg-config.yaml');
      await writeFile(configPath, `
version: "5.0.0"
reviewer:
  tiers:
    cheap:
      provider: claude-code
      consensus: 1
      config: {}
`, 'utf-8');

      const cfg = await parseConfig(configPath);
      expect(cfg.reviewer?.tiers.cheap.model).toBe('haiku');
    });
  });

  describe('parseConfig v5 error codes', () => {
    async function parseWithYaml(yaml: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-v5err-'));
      await writeFile(path.join(dir, 'yg-config.yaml'), yaml, 'utf-8');
      try {
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('config-tiers-missing when reviewer has no tiers key', async () => {
      await expect(parseWithYaml('reviewer:\n  default: foo\n'))
        .rejects.toMatchObject({ code: 'config-tiers-missing' });
    });

    it('config-tiers-empty when tiers is empty mapping', async () => {
      await expect(parseWithYaml('reviewer:\n  tiers: {}\n'))
        .rejects.toMatchObject({ code: 'config-tiers-empty' });
    });

    it('config-default-tier-missing on more than one tier without default', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    a:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
    b:
      provider: claude-code
      consensus: 1
      config: { model: opus }
`)).rejects.toMatchObject({ code: 'config-default-tier-missing' });
    });

    it('config-default-tier-unknown when default refs missing tier', async () => {
      await expect(parseWithYaml(`reviewer:
  default: missing
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-default-tier-unknown' });
    });

    it('config-tier-provider-missing when tier has no provider', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-provider-missing' });
    });

    it('config-tier-provider-unknown for unrecognized provider', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: gpt-5-turbo
      consensus: 1
      config: { model: latest }
`)).rejects.toMatchObject({ code: 'config-tier-provider-unknown' });
    });

    it('config-tier-config-missing when tier has no config block', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
`)).rejects.toMatchObject({ code: 'config-tier-config-missing' });
    });

    it('config-tier-config-not-mapping when config is not a mapping', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: "scalar"
`)).rejects.toMatchObject({ code: 'config-tier-config-not-mapping' });
    });

    it('config-tier-consensus-invalid on missing consensus', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-consensus-invalid' });
    });

    it('config-tier-consensus-invalid on even consensus', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 2
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-consensus-invalid' });
    });

    it('config-tier-name-invalid on bad tier name', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    123foo:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-name-invalid' });
    });

    it('config-tier-name-reserved on tier name "default"', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    default:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-tier-name-reserved' });
    });

    it('config-reviewer-unknown-key for extra reviewer-level key', async () => {
      await expect(parseWithYaml(`reviewer:
  foo: bar
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
`)).rejects.toMatchObject({ code: 'config-reviewer-unknown-key' });
    });

    it('config-tier-unknown-key for extra tier key', async () => {
      await expect(parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config: { model: haiku }
      extra: oops
`)).rejects.toMatchObject({ code: 'config-tier-unknown-key' });
    });

    it('max_tokens in config is silently ignored (no longer a recognized field)', async () => {
      // max_tokens was removed; it is now an unrecognized key in config: and must
      // not cause a parse error regardless of its value.
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        max_tokens: 0
`);
      expect(cfg.reviewer?.tiers.main).toBeDefined();
      expect((cfg.reviewer?.tiers.main as unknown as Record<string, unknown>)['max_tokens']).toBeUndefined();
    });
  });

  it('defaults coverage to whole-repo required when absent', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-default');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\n', 'utf-8');
    const config = await parseConfig(p);
    expect(config.coverage).toEqual({ required: ['/'], excluded: [] });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses coverage.required and coverage.excluded', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-lists');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required:\n    - services/\n  excluded:\n    - vendor/\n', 'utf-8');
    const config = await parseConfig(p);
    expect(config.coverage).toEqual({ required: ['services/'], excluded: ['vendor/'] });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when coverage.required is not an array of strings', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-config-cov-bad');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-config.yaml');
    await writeFile(p, 'version: "5.0.0"\ncoverage:\n  required: services\n', 'utf-8');
    await expect(parseConfig(p)).rejects.toThrow(ConfigParseError);
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('timeout seconds→ms conversion', () => {
    async function parseWithYaml(yaml: string): Promise<YggConfig> {
      const dir = await mkdtemp(path.join(tmpdir(), 'yg-timeout-'));
      await writeFile(path.join(dir, 'yg-config.yaml'), yaml, 'utf-8');
      try {
        return await parseConfig(path.join(dir, 'yg-config.yaml'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('timeout: 5 in config yields 5000 ms internally', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
        timeout: 5
`);
      expect(cfg.reviewer?.tiers.main.timeout).toBe(5000);
    });

    it('timeout absent yields undefined (cli-base applies 120000 ms default)', async () => {
      const cfg = await parseWithYaml(`reviewer:
  tiers:
    main:
      provider: claude-code
      consensus: 1
      config:
        model: haiku
`);
      expect(cfg.reviewer?.tiers.main.timeout).toBeUndefined();
    });
  });

});
