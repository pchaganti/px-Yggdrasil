import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  YggConfig,
  QualityConfig,
  LlmConfig,
  ReviewerConfig,
  CoverageConfig,
} from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';
import { KNOWN_PROVIDERS } from '../utils/known-providers.js';

export { KNOWN_PROVIDERS };

export class ConfigParseError extends Error {
  constructor(public messageData: IssueMessage, public code: string) {
    super(messageData.what);
  }
}

const DEFAULT_QUALITY: QualityConfig = {
  max_direct_relations: 10,
  max_node_chars: 40000,
};

export const DEFAULT_COVERAGE: CoverageConfig = { required: ['/'], excluded: [] };

function parseStringArray(raw: unknown, field: string, filename: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new ConfigParseError({
      what: `${filename}: ${field} must be a list of strings (got ${JSON.stringify(raw)}).`,
      why: 'Coverage roots are repo-relative path prefixes; a non-list value cannot be matched against files.',
      next: `Set ${field} to a YAML list, e.g.\n  ${field.split('.').pop()}:\n    - services/`,
    }, 'config-invalid');
  }
  return raw as string[];
}

function parseCoverage(raw: unknown, filename: string): CoverageConfig {
  if (raw === undefined) return DEFAULT_COVERAGE;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    throw new ConfigParseError({
      what: `${filename}: coverage must be a mapping`,
      why: 'coverage holds the required/excluded root lists',
      next: 'replace with `coverage: { required: ["/"], excluded: [] }`',
    }, 'config-invalid');
  }
  const cov = raw as Record<string, unknown>;
  const required = cov.required === undefined ? ['/'] : parseStringArray(cov.required, 'coverage.required', filename);
  const excluded = parseStringArray(cov.excluded, 'coverage.excluded', filename);

  // An explicit empty required list silently turns every unmapped file into a
  // non-blocking warning, disabling coverage enforcement entirely.
  if (required.length === 0) {
    throw new ConfigParseError({
      what: `${filename}: coverage.required must list at least one root.`,
      why: 'An empty required list silently turns every unmapped file into a non-blocking warning, disabling coverage enforcement.',
      next: 'Omit the coverage block to require the whole repo, or list real roots (e.g. - services/).',
    }, 'config-invalid');
  }

  // Coverage roots are repo-relative prefixes; ".." never matches a git-tracked
  // path and silently mis-scopes coverage enforcement.
  for (const root of [...required, ...excluded]) {
    if (root.split('/').includes('..')) {
      throw new ConfigParseError({
        what: `${filename}: coverage root '${root}' contains a '..' segment.`,
        why: "'..' is not a valid repo-relative prefix and will never match any git-tracked path, silently mis-scoping coverage enforcement.",
        next: 'Use a repo-relative path prefix without any ".." segments (e.g. - services/ instead of - services/../other/).',
      }, 'config-invalid');
    }
  }

  return { required, excluded };
}

/**
 * Validate the optional quality.max_node_chars (the per-node character budget).
 * Absent → the default. Present but not a positive integer → a config error,
 * since a zero/negative/fractional budget makes the oversized-node gate
 * nonsensical (every node, or no node, would trip).
 */
function parseMaxNodeChars(raw: unknown, filename: string): number {
  if (raw === undefined) return DEFAULT_QUALITY.max_node_chars ?? 40000;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ConfigParseError({
      what: `${filename}: quality.max_node_chars must be a positive integer (got ${JSON.stringify(raw)}).`,
      why: 'It is the per-node character budget; a zero, negative, or fractional value makes the oversized-node gate nonsensical.',
      next: 'Set quality.max_node_chars to a positive integer (default 40000), or remove it to use the default.',
    }, 'config-invalid');
  }
  return raw;
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
    throw new ConfigParseError({
      what: `${filename} is empty or not a valid YAML mapping`,
      why: 'the top-level structure must be a YAML mapping with keys like reviewer, quality, parallel',
      next: 'restore the file from version control, or regenerate it via `yg init`',
    }, 'config-invalid');
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined;

  const qualityRaw = raw.quality;
  if (qualityRaw !== undefined && (typeof qualityRaw !== 'object' || Array.isArray(qualityRaw))) {
    throw new ConfigParseError({
      what: `${filename}: quality must be a mapping`,
      why: 'quality holds named thresholds (max_direct_relations, max_node_chars)',
      next: 'replace with `quality: { max_direct_relations: 10, max_node_chars: 40000 }`',
    }, 'config-invalid');
  }
  const qualityMap = qualityRaw as Record<string, unknown> | undefined;
  const quality: QualityConfig = qualityMap
    ? {
        max_direct_relations:
          typeof qualityMap.max_direct_relations === 'number'
            ? qualityMap.max_direct_relations
            : DEFAULT_QUALITY.max_direct_relations,
        max_node_chars: parseMaxNodeChars(qualityMap.max_node_chars, filename),
      }
    : DEFAULT_QUALITY;

  let reviewer: ReviewerConfig | undefined;

  if (raw.reviewer !== undefined) {
    if (
      raw.reviewer && typeof raw.reviewer === 'object' && !Array.isArray(raw.reviewer)
    ) {
      // reviewer: is a mapping — let parseReviewer validate the tiers structure
      // and emit specific errors (config-tiers-missing, config-tiers-empty, etc.)
      reviewer = parseReviewer(raw.reviewer as Record<string, unknown>, filename);
    } else {
      throw new ConfigParseError({
        what: `${filename} has unrecognized reviewer: shape`,
        why: 'reviewer: must be a mapping with a `tiers:` block',
        next: 'see schemas/yg-config.yaml for the expected shape',
      }, 'config-invalid');
    }
  }

  let parallel: number | undefined;
  if (raw.parallel !== undefined) {
    if (typeof raw.parallel !== 'number') {
      throw new ConfigParseError({
        what: `${filename}: parallel must be a number, got ${typeof raw.parallel}`,
        why: 'parallel controls the concurrent-aspect-verification cap',
        next: 'set `parallel: <positive integer>` (e.g. parallel: 10) or remove the key',
      }, 'config-invalid');
    }
    if (!Number.isInteger(raw.parallel) || raw.parallel < 1) {
      throw new ConfigParseError({
        what: `${filename}: parallel must be a positive integer >= 1, got ${raw.parallel}`,
        why: 'parallel controls the concurrent-aspect-verification cap; values < 1 cannot make progress',
        next: 'set `parallel: <positive integer>` (e.g. parallel: 10) or remove the key',
      }, 'config-invalid');
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
    coverage: parseCoverage(raw.coverage, filename),
  };
}

function parseReviewer(raw: Record<string, unknown>, filename: string): ReviewerConfig {
  const allowedTopKeys = new Set(['default', 'tiers']);
  for (const k of Object.keys(raw)) {
    if (!allowedTopKeys.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: unknown key '${k}' under reviewer:`,
        why: 'the reviewer section accepts only `default` and `tiers`',
        next: "move provider-specific settings into a tier's config: section",
      }, 'config-reviewer-unknown-key');
    }
  }

  const tiersRaw = raw.tiers;
  if (!tiersRaw || typeof tiersRaw !== 'object' || Array.isArray(tiersRaw)) {
    throw new ConfigParseError({
      what: `${filename}: reviewer.tiers is missing or not a mapping`,
      why: 'tiers are the only way to declare reviewer configurations',
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
      why: 'consensus is the number of independent reviewer votes per aspect; each tier declares its own',
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
  const allowed = new Set(['provider', 'consensus', 'config', 'references']);
  for (const k of Object.keys(t)) {
    if (!allowed.has(k)) {
      throw new ConfigParseError({
        what: `${filename}: tier '${name}' has unknown key '${k}'`,
        why: 'tier accepts only `provider`, `consensus`, `config`, `references`',
        next: "move to config: if it's a provider setting, or remove",
      }, 'config-tier-unknown-key');
    }
  }

  // references: optional sub-mapping with per-tier source-file size limits
  let references: { max_bytes_per_file?: number; max_total_bytes_per_aspect?: number } | undefined;
  if (t.references !== undefined) {
    if (t.references === null || typeof t.references !== 'object' || Array.isArray(t.references)) {
      throw new ConfigParseError({
        what: `${filename}: tier '${name}' has 'references' that is not a YAML mapping`,
        why: 'references accepts an object with max_bytes_per_file and/or max_total_bytes_per_aspect',
        next: `replace with 'references: { max_bytes_per_file: 65536 }' or remove the field`,
      }, 'tier-references-not-mapping');
    } else {
      const refsObj = t.references as Record<string, unknown>;
      const allowedRefKeys = new Set(['max_bytes_per_file', 'max_total_bytes_per_aspect']);
      for (const k of Object.keys(refsObj)) {
        if (!allowedRefKeys.has(k)) {
          throw new ConfigParseError({
            what: `${filename}: tier '${name}' has unknown key 'references.${k}'`,
            why: 'references accepts only max_bytes_per_file and max_total_bytes_per_aspect',
            next: `remove 'references.${k}' from yg-config.yaml`,
          }, 'tier-references-unknown-key');
        }
      }
      const refs: { max_bytes_per_file?: number; max_total_bytes_per_aspect?: number } = {};
      if (refsObj.max_bytes_per_file !== undefined) {
        const v = refsObj.max_bytes_per_file;
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          throw new ConfigParseError({
            what: `${filename}: tier '${name}' has invalid references.max_bytes_per_file: ${JSON.stringify(v)}`,
            why: 'must be a positive integer (bytes)',
            next: `set 'references.max_bytes_per_file' to a positive integer like 65536`,
          }, 'tier-references-max-bytes-per-file-invalid');
        } else {
          refs.max_bytes_per_file = v;
        }
      }
      if (refsObj.max_total_bytes_per_aspect !== undefined) {
        const v = refsObj.max_total_bytes_per_aspect;
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          throw new ConfigParseError({
            what: `${filename}: tier '${name}' has invalid references.max_total_bytes_per_aspect: ${JSON.stringify(v)}`,
            why: 'must be a positive integer (bytes)',
            next: `set 'references.max_total_bytes_per_aspect' to a positive integer like 262144`,
          }, 'tier-references-max-total-bytes-invalid');
        } else {
          refs.max_total_bytes_per_aspect = v;
        }
      }
      if (Object.keys(refs).length > 0) references = refs;
    }
  }

  return {
    provider: t.provider as LlmConfig['provider'],
    model,
    endpoint: typeof c.endpoint === 'string' ? c.endpoint : undefined,
    temperature: typeof c.temperature === 'number' ? c.temperature : 0,
    consensus: consensusRaw as number,
    timeout: typeof c.timeout === 'number' ? c.timeout * 1000 : undefined,
    ...(references !== undefined ? { references } : {}),
  };
}
