import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
  ReviewerConfig,
} from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';

export class ConfigParseError extends Error {
  constructor(public messageData: IssueMessage, public code: string) {
    super(messageData.what);
  }
}

const DEFAULT_QUALITY: QualityConfig = {
  max_direct_relations: 10,
};

export const KNOWN_PROVIDERS = [
  'ollama', 'openai', 'anthropic', 'google', 'openai-compatible',
  'claude-code', 'codex', 'gemini-cli',
] as const;

// ---- inline format-detection predicates (avoid circular import with format-version.ts) ----

function _isV5ConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object' || Array.isArray(reviewer)) return false;
  // v5 shape: has `tiers` key, OR has `default` key (both are v5-exclusive keys)
  return 'tiers' in reviewer || 'default' in reviewer;
}

function _isV4ConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object' || Array.isArray(reviewer)) return false;
  if (_isV5ConfigFormat(raw)) return false;
  return 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
}

function _isMixedConfigFormat(raw: Record<string, unknown>): boolean {
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (!reviewer || typeof reviewer !== 'object') return false;
  const hasV5 = 'tiers' in reviewer;
  const hasV4 = 'active' in reviewer || KNOWN_PROVIDERS.some(p => p in reviewer);
  return hasV5 && hasV4;
}

const PROVIDER_DEFAULTS: Record<string, Partial<LlmConfig>> = {
  'claude-code': { model: 'haiku' },
  'codex': { model: 'o4-mini' },
  'gemini-cli': { model: 'gemini-2.5-flash' },
};

export async function parseConfig(filePath: string): Promise<YggConfig> {
  const filename = path.basename(filePath);
  const content = await readFile(filePath, 'utf-8');
  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`${filename}: file is empty or not a valid YAML mapping`);
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  const qualityRaw = raw.quality;
  if (qualityRaw !== undefined && (typeof qualityRaw !== 'object' || Array.isArray(qualityRaw))) {
    throw new Error(`${filename}: quality must be a mapping`);
  }
  const qualityMap = qualityRaw as Record<string, unknown> | undefined;
  const quality: QualityConfig = qualityMap
    ? {
        max_direct_relations:
          typeof qualityMap.max_direct_relations === 'number'
            ? qualityMap.max_direct_relations
            : DEFAULT_QUALITY.max_direct_relations,
        max_mapping_source_files:
          typeof qualityMap.max_mapping_source_files === 'number'
            ? qualityMap.max_mapping_source_files
            : undefined,
      }
    : DEFAULT_QUALITY;

  // Parse reviewer: section
  let reviewer: ReviewerConfig | undefined;

  if (raw.reviewer !== undefined) {
    if (_isMixedConfigFormat(raw)) {
      throw new ConfigParseError({
        what: `${filename} has both v4 and v5 reviewer shapes`,
        why: 'v5 config must contain only reviewer.default and reviewer.tiers; legacy keys must be removed',
        next: 'remove the legacy keys (reviewer.active, reviewer.<provider-name>) — their content should already be inside reviewer.tiers',
      }, 'config-reviewer-mixed-format');
    } else if (_isV5ConfigFormat(raw)) {
      reviewer = parseReviewerV5(raw.reviewer as Record<string, unknown>, filename);
    } else if (_isV4ConfigFormat(raw)) {
      throw new ConfigParseError({
        what: `${filename} uses the pre-v5 reviewer format`,
        why: 'v5 expects reviewer.tiers instead of provider sections directly under reviewer:',
        next: 'run `yg init --upgrade` to migrate',
      }, 'config-reviewer-legacy-format');
    } else {
      throw new ConfigParseError({
        what: `${filename} has unrecognized reviewer: shape`,
        why: 'reviewer: must be a v5 mapping with tiers:',
        next: 'see schemas/yg-config.yaml for the v5 shape',
      }, 'config-invalid');
    }
  }

  let parallel: number | undefined;
  if (raw.parallel !== undefined) {
    if (typeof raw.parallel !== 'number') {
      throw new Error(`${filename}: parallel must be a number, got ${typeof raw.parallel}`);
    }
    if (!Number.isInteger(raw.parallel) || raw.parallel < 1) {
      throw new Error(`${filename}: parallel must be a positive integer >= 1, got ${raw.parallel}`);
    }
    parallel = raw.parallel;
  }

  const debug = raw.debug === true ? true : undefined;

  return {
    version,
    quality,
    reviewer,
    parallel,
    debug,
  };
}

function parseReviewerV5(raw: Record<string, unknown>, filename: string): ReviewerConfig {
  const allowedTopKeys = new Set(['default', 'tiers']);
  for (const k of Object.keys(raw)) {
    if (!allowedTopKeys.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: unknown key '${k}' under reviewer:`,
        why: 'v5 reviewer section accepts only `default` and `tiers`',
        next: "move provider-specific settings into a tier's config: section",
      }, 'config-reviewer-unknown-key');
    }
  }

  const tiersRaw = raw.tiers;
  if (!tiersRaw || typeof tiersRaw !== 'object' || Array.isArray(tiersRaw)) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.tiers is missing or not a mapping`,
      why: 'tiers are the only way to declare reviewer configurations in v5',
      next: 'add `reviewer.tiers: { default-tier: { provider: ..., consensus: 1, config: { model: ... } } }`',
    }, 'config-tiers-missing');
  }

  const tiers: Record<string, LlmConfig> = {};
  const tierNameRegex = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
  for (const [tierName, tierRawAny] of Object.entries(tiersRaw as Record<string, unknown>)) {
    if (tierName === 'default') {
      throw new ConfigParseError({
        what: `${filename}: tier name 'default' is reserved`,
        why: 'a tier named "default" is visually identical to reviewer.default pointing to itself',
        next: 'rename the tier (referenced by aspects via reviewer.tier:)',
      }, 'config-tier-name-reserved');
    }
    if (!tierNameRegex.test(tierName)) {
      throw new ConfigParseError({
        what: `${filename}: tier name '${tierName}' is invalid`,
        why: 'tier names must start with a letter and contain only letters, digits, underscore, or hyphen (max 63 chars)',
        next: `rename the tier (regex: ${tierNameRegex.source})`,
      }, 'config-tier-name-invalid');
    }
    tiers[tierName] = parseTier(tierName, tierRawAny, filename);
  }

  if (Object.keys(tiers).length === 0) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.tiers is empty`,
      why: 'at least one tier must be defined',
      next: 'add at least one tier entry',
    }, 'config-tiers-empty');
  }

  let defaultName: string | undefined;
  if ('default' in raw) {
    if (typeof raw.default !== 'string') {
      throw new ConfigParseError({
        what: `${filename}: reviewer.default must be a string`,
        why: 'default references a tier by name',
        next: `set reviewer.default to one of: ${Object.keys(tiers).join(', ')}`,
      }, 'config-default-tier-unknown');
    }
    if (!tiers[raw.default]) {
      throw new ConfigParseError({
        what: `${filename}: reviewer.default is '${raw.default}' but no tier '${raw.default}' is configured`,
        why: 'reference must match a tier name',
        next: `use one of: ${Object.keys(tiers).join(', ')}`,
      }, 'config-default-tier-unknown');
    }
    defaultName = raw.default;
  } else if (Object.keys(tiers).length > 1) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.default is required when multiple tiers are configured`,
      why: 'with multiple tiers, the default must be chosen explicitly',
      next: `set reviewer.default to one of: ${Object.keys(tiers).join(', ')}`,
    }, 'config-default-tier-missing');
  }

  return { default: defaultName, tiers };
}

function parseTier(name: string, raw: unknown, filename: string): LlmConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is not a mapping`,
      why: 'each tier is a mapping with provider, consensus, config',
      next: 'replace with `{ provider: ..., consensus: 1, config: { model: ... } }`',
    }, 'config-tier-invalid');
  }
  const t = raw as Record<string, unknown>;

  if (!t.provider) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing provider:`,
      why: 'each tier must declare which provider implements it',
      next: `add 'provider: <one-of-known>' (see KNOWN_PROVIDERS)`,
    }, 'config-tier-provider-missing');
  }
  if (typeof t.provider !== 'string' || !(KNOWN_PROVIDERS as readonly string[]).includes(t.provider)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' declares unknown provider '${String(t.provider)}'`,
      why: 'provider must be one the CLI knows how to invoke',
      next: `use one of: ${KNOWN_PROVIDERS.join(', ')}`,
    }, 'config-tier-provider-unknown');
  }

  if (!('consensus' in t)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing consensus:`,
      why: 'consensus is the number of independent reviewer votes per aspect; v5 requires it explicitly per tier',
      next: 'add `consensus: 1` (single call) or an odd number >= 3 for majority vote',
    }, 'config-tier-consensus-invalid');
  }
  const consensusRaw = t.consensus;
  if (!Number.isInteger(consensusRaw) || (consensusRaw as number) < 1 || (consensusRaw as number) % 2 === 0) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' has invalid consensus '${consensusRaw}'`,
      why: 'consensus must be a positive odd integer; even values cannot break ties; < 1 is nonsensical',
      next: 'use 1 (single call) or an odd number >= 3 for majority vote',
    }, 'config-tier-consensus-invalid');
  }

  if (!('config' in t)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' is missing config:`,
      why: 'provider-specific settings live in config:',
      next: 'add `config: { model: <model-name> }`',
    }, 'config-tier-config-missing');
  }
  const cfg = t.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' has config: that is not a YAML mapping`,
      why: 'provider settings are key-value pairs',
      next: 'replace with `config: { model: <name>, ... }`',
    }, 'config-tier-config-not-mapping');
  }
  const c = cfg as Record<string, unknown>;
  const defaults = PROVIDER_DEFAULTS[t.provider as string] ?? {};
  const model = (c.model as string | undefined) ?? (defaults.model as string | undefined);
  if (!model || typeof model !== 'string') {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' config.model is missing or not a string`,
      why: 'every tier requires a model id',
      next: 'add `model: <model-name>` under config:',
    }, 'config-tier-config-missing');
  }

  // Unknown-key check AFTER structural checks
  const allowed = new Set(['provider', 'consensus', 'config']);
  for (const k of Object.keys(t)) {
    if (!allowed.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: tier '${name}' has unknown key '${k}'`,
        why: 'tier accepts only `provider`, `consensus`, `config`',
        next: "move to config: if it's a provider setting, or remove",
      }, 'config-tier-unknown-key');
    }
  }

  const maxTokens = c.max_tokens ?? 'auto';
  if (maxTokens !== 'auto' && (typeof maxTokens !== 'number' || (maxTokens as number) < 1)) {
    throw new ConfigParseError({
      what: `${filename}: tier '${name}' config.max_tokens must be 'auto' or a positive number`,
      why: 'max_tokens controls the LLM response budget; invalid values cause runtime errors',
      next: "set to 'auto' or a positive integer (e.g. 4096)",
    }, 'config-tier-config-invalid');
  }
  return {
    provider: t.provider as LlmConfig['provider'],
    model,
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : undefined,
    temperature: typeof c.temperature === 'number' ? c.temperature : 0,
    consensus: consensusRaw as number,
    max_tokens: maxTokens,
    context_length_field: typeof c.context_length_field === 'string' ? c.context_length_field : undefined,
    timeout: typeof c.timeout === 'number' ? c.timeout : undefined,
  };
}
