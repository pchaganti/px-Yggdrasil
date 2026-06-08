import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseConfig,
  ConfigParseError,
  DEFAULT_COVERAGE,
  KNOWN_PROVIDERS,
} from '../../../src/io/config-parser.js';
import {
  inspectSecretsForValidation,
  loadSecrets,
  mergeLlmConfig,
} from '../../../src/io/secrets-parser.js';
import type { LlmConfig } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// BOUNTY 4 — yg-config.yaml spec conformance.
//
// THE SPEC IS THE AUTHORITY. Source of truth:
//   node dist/bin.js knowledge read configuration
//   (+ .yggdrasil/schemas/yg-config.yaml)
//
// Each test exercises the REAL parser (src/io/config-parser.ts) and the REAL
// secrets parser (src/io/secrets-parser.ts) against one documented invariant.
//
// Determinism: no RNG, no wall-clock assertions, no network/LLM. Every fixture
// is authored in a fresh mkdtemp dir and removed in afterEach.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function cfg(yaml: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'bounty4-cfg-'));
  tmpDirs.push(d);
  const p = path.join(d, 'yg-config.yaml');
  await writeFile(p, yaml, 'utf-8');
  return p;
}

async function secretsDir(yaml: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'bounty4-sec-'));
  tmpDirs.push(d);
  await writeFile(path.join(d, 'yg-secrets.yaml'), yaml, 'utf-8');
  return d;
}

/** A syntactically valid single tier whose endpoint avoids any required-endpoint ambiguity. */
const VALID_TIER = `
    standard:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        endpoint: http://localhost:11434`;

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ===========================================================================
// version
// ===========================================================================
describe('version', () => {
  it('is undefined when absent (managed by CLI, not required from user)', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.version).toBeUndefined();
  });

  it('is read as a string and trimmed of surrounding whitespace', async () => {
    const c = await parseConfig(await cfg(`version: "  5.1.0  "\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.version).toBe('5.1.0');
  });

  it('is undefined when not a string (e.g. a bare number)', async () => {
    const c = await parseConfig(await cfg(`version: 5\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.version).toBeUndefined();
  });
});

// ===========================================================================
// top-level shape / error: config-invalid
// ===========================================================================
describe('top-level structure', () => {
  it('an empty file is rejected (not a valid YAML mapping)', async () => {
    await expect(parseConfig(await cfg(''))).rejects.toBeInstanceOf(ConfigParseError);
  });

  it('the empty-file error carries code config-invalid', async () => {
    try {
      await parseConfig(await cfg(''));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError);
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });
});

// ===========================================================================
// quality thresholds — defaults & validation
// ===========================================================================
describe('quality', () => {
  it('defaults max_node_chars to 40000 when the quality block is absent', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.quality?.max_node_chars).toBe(40000);
  });

  it('defaults max_direct_relations to 10 when the quality block is absent', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.quality?.max_direct_relations).toBe(10);
  });

  it('defaults max_node_chars to 40000 when quality is present but max_node_chars omitted', async () => {
    const c = await parseConfig(await cfg(`quality:\n  max_direct_relations: 5\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.quality?.max_node_chars).toBe(40000);
  });

  it('honours an explicit positive integer max_node_chars', async () => {
    const c = await parseConfig(await cfg(`quality:\n  max_node_chars: 12345\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.quality?.max_node_chars).toBe(12345);
  });

  it('honours an explicit max_direct_relations', async () => {
    const c = await parseConfig(await cfg(`quality:\n  max_direct_relations: 25\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.quality?.max_direct_relations).toBe(25);
  });

  it('rejects a negative max_node_chars (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`quality:\n  max_node_chars: -5\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a zero max_node_chars (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`quality:\n  max_node_chars: 0\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a fractional max_node_chars (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`quality:\n  max_node_chars: 1000.5\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a quality block that is not a mapping (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`quality:\n  - 1\n  - 2\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });
});

// ===========================================================================
// coverage — defaults, empty-required semantics, validation
// ===========================================================================
describe('coverage', () => {
  it('DEFAULT_COVERAGE is required ["/"], excluded []', () => {
    expect(DEFAULT_COVERAGE).toEqual({ required: ['/'], excluded: [] });
  });

  it('defaults to required ["/"] / excluded [] when the coverage block is absent', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.coverage).toEqual({ required: ['/'], excluded: [] });
  });

  it('preserves an explicit empty required: [] (require-nothing semantics)', async () => {
    const c = await parseConfig(await cfg(`coverage:\n  required: []\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.coverage?.required).toEqual([]);
  });

  it('defaults required to ["/"] when coverage present but required omitted', async () => {
    const c = await parseConfig(await cfg(`coverage:\n  excluded:\n    - vendor/\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.coverage?.required).toEqual(['/']);
    expect(c.coverage?.excluded).toEqual(['vendor/']);
  });

  it('defaults excluded to [] when omitted', async () => {
    const c = await parseConfig(await cfg(`coverage:\n  required:\n    - src/\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.coverage?.excluded).toEqual([]);
  });

  it('accepts directory-prefix and glob roots verbatim', async () => {
    const c = await parseConfig(
      await cfg(`coverage:\n  required:\n    - "services/*/api/**"\n  excluded:\n    - "**/*.generated.ts"\nreviewer:\n  tiers:${VALID_TIER}\n`),
    );
    expect(c.coverage?.required).toEqual(['services/*/api/**']);
    expect(c.coverage?.excluded).toEqual(['**/*.generated.ts']);
  });

  it('rejects a coverage root containing a ".." segment (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`coverage:\n  required:\n    - "src/../x"\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a coverage block that is not a mapping (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`coverage:\n  - "/"\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects required that is not a list of strings (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`coverage:\n  required: 5\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });
});

// ===========================================================================
// parallel — default & validation
// ===========================================================================
describe('parallel', () => {
  it('honours an explicit positive integer', async () => {
    const c = await parseConfig(await cfg(`parallel: 10\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.parallel).toBe(10);
  });

  it('rejects parallel: 0 (must be >= 1) with config-invalid', async () => {
    try {
      await parseConfig(await cfg(`parallel: 0\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a negative parallel (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`parallel: -3\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a fractional parallel (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`parallel: 2.5\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });

  it('rejects a non-numeric parallel (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`parallel: "ten"\nreviewer:\n  tiers:${VALID_TIER}\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });
});

// ===========================================================================
// debug — default false (off when absent)
// ===========================================================================
describe('debug', () => {
  it('debug is off (not true) when absent — spec default false', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.debug).not.toBe(true);
  });

  it('debug: true is honoured', async () => {
    const c = await parseConfig(await cfg(`debug: true\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.debug).toBe(true);
  });

  it('debug: false stays off', async () => {
    const c = await parseConfig(await cfg(`debug: false\nreviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.debug).not.toBe(true);
  });
});

// ===========================================================================
// reviewer.default — required with >1 tier, optional with exactly one
// ===========================================================================
describe('reviewer.default', () => {
  it('is optional with exactly one tier (single tier is implicitly default)', async () => {
    const c = await parseConfig(await cfg(`reviewer:\n  tiers:${VALID_TIER}\n`));
    expect(c.reviewer).toBeDefined();
    expect(c.reviewer?.default).toBeUndefined();
    expect(Object.keys(c.reviewer!.tiers)).toEqual(['standard']);
  });

  it('is REQUIRED with more than one tier — config-default-tier-missing', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://e }
    deep:
      provider: anthropic
      consensus: 3
      config: { model: claude-opus-4-7 }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-default-tier-missing');
    }
  });

  it('is honoured when present and resolves to an existing tier', async () => {
    const yaml = `reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://e }
    deep:
      provider: anthropic
      consensus: 3
      config: { model: claude-opus-4-7 }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.default).toBe('standard');
    expect(Object.keys(c.reviewer!.tiers).sort()).toEqual(['deep', 'standard']);
  });

  it('must reference an existing tier — config-default-tier-unknown', async () => {
    const yaml = `reviewer:
  default: nope
  tiers:${VALID_TIER}
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-default-tier-unknown');
    }
  });

  it('a non-string default is rejected (config-default-tier-unknown)', async () => {
    const yaml = `reviewer:
  default: 5
  tiers:${VALID_TIER}
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-default-tier-unknown');
    }
  });
});

// ===========================================================================
// reviewer.tiers — presence, emptiness, unknown keys
// ===========================================================================
describe('reviewer.tiers', () => {
  it('rejects reviewer without a tiers mapping — config-tiers-missing', async () => {
    try {
      await parseConfig(await cfg(`reviewer:\n  default: standard\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tiers-missing');
    }
  });

  it('rejects an unknown key under reviewer — config-reviewer-unknown-key', async () => {
    const yaml = `reviewer:
  active: standard
  tiers:${VALID_TIER}
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-reviewer-unknown-key');
    }
  });

  it('rejects a reviewer that is not a mapping (config-invalid)', async () => {
    try {
      await parseConfig(await cfg(`reviewer: standard\n`));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-invalid');
    }
  });
});

// ===========================================================================
// reviewer.tiers.<name> — name regex & reserved 'default'
// ===========================================================================
describe('tier names', () => {
  it("the literal name 'default' is reserved — config-tier-name-reserved", async () => {
    const yaml = `reviewer:
  tiers:
    default:
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-name-reserved');
    }
  });

  it('rejects a tier name that violates ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ — config-tier-name-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    "1bad":
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-name-invalid');
    }
  });

  it('accepts a conventional tier name with hyphen/underscore/digits', async () => {
    const yaml = `reviewer:
  tiers:
    deep_2-x:
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(Object.keys(c.reviewer!.tiers)).toEqual(['deep_2-x']);
  });
});

// ===========================================================================
// reviewer.tiers.<name>.provider — one of the 8 known providers
// ===========================================================================
describe('tier provider', () => {
  it('KNOWN_PROVIDERS is exactly the 8 documented providers', () => {
    expect([...KNOWN_PROVIDERS].sort()).toEqual(
      [
        'anthropic',
        'claude-code',
        'codex',
        'gemini-cli',
        'google',
        'ollama',
        'openai',
        'openai-compatible',
      ].sort(),
    );
  });

  it('rejects a tier missing provider — config-tier-provider-missing', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      consensus: 1
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-provider-missing');
    }
  });

  it('rejects an unknown provider — config-tier-provider-unknown', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: bedrock
      consensus: 1
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-provider-unknown');
    }
  });

  it('accepts each documented provider', async () => {
    for (const provider of KNOWN_PROVIDERS) {
      const yaml = `reviewer:
  tiers:
    standard:
      provider: ${provider}
      consensus: 1
      config: { model: m, endpoint: http://e }
`;
      const c = await parseConfig(await cfg(yaml));
      expect(c.reviewer?.tiers.standard.provider).toBe(provider);
    }
  });
});

// ===========================================================================
// reviewer.tiers.<name>.consensus — positive odd integer
// ===========================================================================
describe('tier consensus', () => {
  it('rejects a missing consensus — config-tier-consensus-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-consensus-invalid');
    }
  });

  it('accepts consensus: 1 (single call)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.consensus).toBe(1);
  });

  it('accepts consensus: 3 (majority vote)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 3
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.consensus).toBe(3);
  });

  it('rejects an even consensus (cannot break ties) — config-tier-consensus-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 2
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-consensus-invalid');
    }
  });

  it('rejects consensus < 1 — config-tier-consensus-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: -1
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-consensus-invalid');
    }
  });

  it('rejects a fractional consensus — config-tier-consensus-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1.5
      config: { model: m }
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-consensus-invalid');
    }
  });
});

// ===========================================================================
// reviewer.tiers.<name>.config — model required, defaults, types
// ===========================================================================
describe('tier config', () => {
  it('rejects a tier missing the config block (config-tier-config-missing)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-config-missing');
    }
  });

  it('rejects a config that is not a mapping (config-tier-config-not-mapping)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: "model=m"
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-config-not-mapping');
    }
  });

  it('requires config.model for a provider with no default model (anthropic)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: {}
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError);
      // model is a required field per the config field table
      expect((e as ConfigParseError).messageData.what).toMatch(/config\.model/);
    }
  });

  it('honours an explicit config.model', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: claude-opus-4-7 }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.model).toBe('claude-opus-4-7');
  });

  it('temperature defaults to 0 when omitted (spec: defaults to 0)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.temperature).toBe(0);
  });

  it('honours an explicit temperature', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m, temperature: 0.7 }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.temperature).toBe(0.7);
  });

  it('honours an explicit endpoint', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: openai-compatible
      consensus: 1
      config: { model: m, endpoint: http://my-llm:9000 }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.endpoint).toBe('http://my-llm:9000');
  });

  it('converts config.timeout from seconds to milliseconds', async () => {
    // Spec: "Timeout in seconds." LlmConfig.timeout is in ms.
    const yaml = `reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config: { model: m, timeout: 5 }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.timeout).toBe(5000);
  });

  it('leaves timeout undefined when omitted (downstream applies the 300s default)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.timeout).toBeUndefined();
  });

  it('rejects an unknown top-level tier key — config-tier-unknown-key', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
      foo: bar
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('config-tier-unknown-key');
    }
  });
});

// ===========================================================================
// CLI providers carry built-in default models (no model required)
// ===========================================================================
describe('CLI provider default models', () => {
  it('claude-code defaults to model "haiku" when config.model omitted', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: claude-code
      consensus: 1
      config: {}
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.model).toBe('haiku');
  });

  it('codex defaults to model "o4-mini"', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: codex
      consensus: 1
      config: {}
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.model).toBe('o4-mini');
  });

  it('gemini-cli defaults to model "gemini-2.5-flash"', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: gemini-cli
      consensus: 1
      config: {}
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.model).toBe('gemini-2.5-flash');
  });
});

// ===========================================================================
// Tier reference limits — defaults & validation
// ===========================================================================
describe('tier references', () => {
  it('references is undefined when omitted (downstream applies 64KiB / 256KiB defaults)', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.references).toBeUndefined();
  });

  it('honours explicit reference caps', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
      references:
        max_bytes_per_file: 100
        max_total_bytes_per_aspect: 500
`;
    const c = await parseConfig(await cfg(yaml));
    expect(c.reviewer?.tiers.standard.references).toEqual({
      max_bytes_per_file: 100,
      max_total_bytes_per_aspect: 500,
    });
  });

  it('rejects an unknown references sub-key — tier-references-unknown-key', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
      references:
        max_bytes: 100
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('tier-references-unknown-key');
    }
  });

  it('rejects a non-positive max_bytes_per_file — tier-references-max-bytes-per-file-invalid', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
      references:
        max_bytes_per_file: 0
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('tier-references-max-bytes-per-file-invalid');
    }
  });

  it('rejects references that is not a mapping — tier-references-not-mapping', async () => {
    const yaml = `reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config: { model: m }
      references: 65536
`;
    try {
      await parseConfig(await cfg(yaml));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ConfigParseError).code).toBe('tier-references-not-mapping');
    }
  });
});

// ===========================================================================
// Secrets — yg-secrets.yaml accepts only api_key per provider
// ===========================================================================
describe('secrets handling', () => {
  it('inspectSecretsForValidation reports a foreign (non-api_key) field per provider', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: sk-x\n    base_url: http://x\n`);
    const found = await inspectSecretsForValidation(dir);
    expect(found).toEqual([{ provider: 'anthropic', foreignKeys: ['base_url'] }]);
  });

  it('inspectSecretsForValidation reports nothing when only api_key is present', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: sk-x\n`);
    const found = await inspectSecretsForValidation(dir);
    expect(found).toEqual([]);
  });

  it('inspectSecretsForValidation returns [] when the secrets file is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bounty4-nosec-'));
    tmpDirs.push(dir);
    const found = await inspectSecretsForValidation(dir);
    expect(found).toEqual([]);
  });

  it('loadSecrets extracts only api_key for the named provider', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: sk-secret\n    base_url: http://x\n`);
    const s = await loadSecrets(dir, 'anthropic');
    expect(s).toEqual({ api_key: 'sk-secret' });
  });

  it('loadSecrets returns undefined when no provider is requested', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: sk-x\n`);
    const s = await loadSecrets(dir, undefined);
    expect(s).toBeUndefined();
  });

  it('loadSecrets ignores an empty/blank api_key (returns undefined)', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: "   "\n`);
    const s = await loadSecrets(dir, 'anthropic');
    expect(s).toBeUndefined();
  });

  it('loadSecrets throws when api_key has the wrong type', async () => {
    const dir = await secretsDir(`reviewer:\n  anthropic:\n    api_key: 12345\n`);
    await expect(loadSecrets(dir, 'anthropic')).rejects.toThrow(/api_key/);
  });

  it('mergeLlmConfig overlays secrets onto the base config', () => {
    const base: LlmConfig = { provider: 'anthropic', model: 'm', temperature: 0, consensus: 1 };
    const merged = mergeLlmConfig(base, { api_key: 'sk-merged' });
    expect(merged.api_key).toBe('sk-merged');
    expect(merged.model).toBe('m');
  });
});
