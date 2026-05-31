import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';
import { KNOWN_PROVIDERS } from '../utils/known-providers.js';
import {
  isCurrentConfigFormat,
  isLegacyAspectReviewer,
} from '../core/format-detect.js';
import { inspectSecretsForValidation } from '../io/secrets-parser.js';
import { addAspectStatusDefaults } from './aspect-status-defaults.js';
import { toPosix } from '../utils/posix.js';

const PROVIDER_SET = new Set<string>(KNOWN_PROVIDERS);
const AST_STRING = 'ast';
const LLM_STRING = 'llm';
const DETERMINISTIC_STRING = 'deterministic';

// ── pure transformations ───────────────────────────────────────

export interface ConfigTransformResult {
  value: Record<string, unknown> | undefined;
  warnings: string[];
  actions: string[];
  changed: boolean;
}

/**
 * Transform a legacy reviewer block (active + provider-keyed) into the
 * current tiers + default shape. Pure; no I/O. Returns:
 *   - `value: undefined` when the input is already current-shape OR when
 *     warnings prevent migration (caller must NOT write).
 *   - `value: <new reviewer>` when the input can be migrated cleanly.
 */
export function transformConfigReviewer(
  reviewer: Record<string, unknown>,
): ConfigTransformResult {
  const warnings: string[] = [];
  const actions: string[] = [];

  if ('tiers' in reviewer) {
    return { value: undefined, warnings, actions, changed: false };
  }

  const hasActive = 'active' in reviewer;
  const providerKeys = Object.keys(reviewer).filter((k) => PROVIDER_SET.has(k));

  if (!hasActive && providerKeys.length === 0) {
    return { value: undefined, warnings, actions, changed: false };
  }

  if (!hasActive && providerKeys.length > 1) {
    warnings.push(
      `yg-config.yaml: cannot migrate reviewer — multiple providers (${providerKeys.join(', ')}) declared without reviewer.active. ` +
        'Migration cannot infer which tier should be default. ' +
        'Open yg-config.yaml, set `reviewer.active: <one-of-providers>` matching your intended default, then re-run `yg init --upgrade`.',
    );
    return { value: undefined, warnings, actions, changed: false };
  }

  let activeProvider: string | undefined;
  if (hasActive) {
    if (typeof reviewer.active !== 'string') {
      warnings.push(
        `yg-config.yaml: cannot migrate reviewer — reviewer.active is not a string (got ${typeof reviewer.active}). ` +
          'Set it to one of the configured provider names, then re-run `yg init --upgrade`.',
      );
      return { value: undefined, warnings, actions, changed: false };
    }
    activeProvider = reviewer.active;
    if (!providerKeys.includes(activeProvider)) {
      warnings.push(
        `yg-config.yaml: cannot migrate reviewer — reviewer.active is '${activeProvider}' but no matching provider section ` +
          `(${providerKeys.join(', ') || 'none'}) is configured. ` +
          'Fix reviewer.active, then re-run `yg init --upgrade`.',
      );
      return { value: undefined, warnings, actions, changed: false };
    }
  } else if (providerKeys.length === 1) {
    activeProvider = providerKeys[0];
  }

  const rawConsensus = reviewer.consensus;
  const globalConsensus =
    typeof rawConsensus === 'number' ? rawConsensus : 1;

  if (
    typeof rawConsensus === 'number' &&
    (rawConsensus < 1 || !Number.isInteger(rawConsensus) || rawConsensus % 2 === 0)
  ) {
    const detail =
      rawConsensus % 2 === 0 && Number.isInteger(rawConsensus) && rawConsensus >= 1
        ? `${rawConsensus} is even`
        : `${rawConsensus} is not a positive odd integer`;
    warnings.push(
      `yg-config.yaml: global reviewer.consensus ${detail} — ` +
        'v5 requires a positive odd per-tier consensus (3+ for majority vote). ' +
        'Set an odd value (1, 3, 5, …) and re-run `yg init --upgrade`.',
    );
    return { value: undefined, warnings, actions, changed: false };
  }

  const tiers: Record<string, Record<string, unknown>> = {};
  for (const provider of providerKeys) {
    const providerSection = reviewer[provider];
    const tierConfig: Record<string, unknown> =
      providerSection &&
      typeof providerSection === 'object' &&
      !Array.isArray(providerSection)
        ? { ...(providerSection as Record<string, unknown>) }
        : {};
    tiers[provider] = {
      provider,
      consensus: globalConsensus,
      config: tierConfig,
    };
  }

  if (globalConsensus > 1) {
    actions.push(
      `yg-config.yaml: global reviewer.consensus ${globalConsensus} copied into every tier (${Object.keys(tiers).join(', ')}). ` +
        'Review whether you want this value on each tier; lower per-tier consensus if not.',
    );
  }

  const v5: Record<string, unknown> = { tiers };
  if (Object.keys(tiers).length > 1 && activeProvider) {
    v5.default = activeProvider;
  }

  return { value: v5, warnings, actions, changed: true };
}

export interface AspectTransformResult {
  value: Record<string, unknown> | undefined;
  warnings: string[];
  changed: boolean;
}

/**
 * Transform a legacy aspect reviewer field (absent | null | 'llm' | 'ast')
 * into a mapping form `{ type: 'llm' | 'deterministic' }`. Pure; no I/O.
 * The legacy `'ast'` string maps to `{ type: 'deterministic' }` for the
 * 5.0.0 two-value reviewer enum.
 *
 *   - Returns `undefined` when the input is already mapping-shape or
 *     when warnings prevent migration (caller must NOT write).
 *   - Emits a warning for unrecognized strings, mapping without `type:`,
 *     and other non-mapping/non-string values; the file is left unchanged.
 */
export function transformAspectReviewer(
  raw: Record<string, unknown>,
): AspectTransformResult {
  const warnings: string[] = [];
  const reviewer = raw.reviewer;

  if (reviewer === undefined || reviewer === null) {
    return {
      value: { ...raw, reviewer: { type: LLM_STRING } },
      warnings,
      changed: true,
    };
  }

  if (typeof reviewer === 'string') {
    if (reviewer === AST_STRING) {
      return {
        value: { ...raw, reviewer: { type: DETERMINISTIC_STRING } },
        warnings,
        changed: true,
      };
    }
    if (reviewer === LLM_STRING) {
      return {
        value: { ...raw, reviewer: { type: LLM_STRING } },
        warnings,
        changed: true,
      };
    }
    warnings.push(
      `unrecognized reviewer value '${reviewer}' (expected 'llm' or 'deterministic'). ` +
        'Set reviewer to `{ type: llm }` or `{ type: deterministic }` manually.',
    );
    return { value: undefined, warnings, changed: false };
  }

  if (typeof reviewer === 'object' && !Array.isArray(reviewer)) {
    const obj = reviewer as Record<string, unknown>;
    if (!('type' in obj)) {
      warnings.push(
        'reviewer mapping has no `type:` key. ' +
          'Set `reviewer.type` to `llm` or `deterministic` manually.',
      );
      return { value: undefined, warnings, changed: false };
    }
    return { value: undefined, warnings, changed: false };
  }

  warnings.push(
    `reviewer has an unexpected value (type: ${typeof reviewer}). ` +
      'Set reviewer to `{ type: llm }` or `{ type: deterministic }` manually.',
  );
  return { value: undefined, warnings, changed: false };
}

// ── I/O wrappers ──────────────────────────────────────────────

async function migrateConfigFile(
  yggRoot: string,
  actions: string[],
  warnings: string[],
): Promise<{ proceedWithAspects: boolean }> {
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      warnings.push('yg-config.yaml not found — reviewer config migration skipped.');
      return { proceedWithAspects: false };
    }
    throw e;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(content) as Record<string, unknown>;
  } catch (e) {
    warnings.push(
      `yg-config.yaml: parse error — ${(e as Error).message}. Fix the YAML, then re-run \`yg init --upgrade\`.`,
    );
    return { proceedWithAspects: false };
  }

  if (!parsed || typeof parsed !== 'object') {
    warnings.push('yg-config.yaml: top-level is not a YAML mapping. Restore the file, then re-run `yg init --upgrade`.');
    return { proceedWithAspects: false };
  }

  if (isCurrentConfigFormat(parsed)) {
    return { proceedWithAspects: true };
  }

  const reviewer = parsed.reviewer;
  if (!reviewer || typeof reviewer !== 'object' || Array.isArray(reviewer)) {
    return { proceedWithAspects: true };
  }

  const transformed = transformConfigReviewer(reviewer as Record<string, unknown>);
  actions.push(...transformed.actions);
  if (transformed.warnings.length > 0) {
    warnings.push(...transformed.warnings);
    return { proceedWithAspects: false };
  }
  if (transformed.value !== undefined) {
    parsed.reviewer = transformed.value;
    await writeFile(configPath, stringifyYaml(parsed, { lineWidth: 0 }), 'utf-8');
    const tierNames = Object.keys(
      (transformed.value as { tiers: Record<string, unknown> }).tiers,
    );
    actions.push(
      `yg-config.yaml: migrated reviewer to tier-based shape (tiers: ${tierNames.join(', ')}).`,
    );
  }
  return { proceedWithAspects: true };
}

async function migrateAllAspects(
  yggRoot: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  const aspectsDir = path.join(yggRoot, 'aspects');
  try {
    await scanAspectsDir(aspectsDir, '', actions, warnings);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

async function scanAspectsDir(
  rootDir: string,
  relPath: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  const dir = path.join(rootDir, relPath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }

  const aspectId = toPosix(relPath);
  const aspectYamlPath = path.join(dir, 'yg-aspect.yaml');
  let hasAspectYaml = false;
  try {
    await readFile(aspectYamlPath, 'utf-8');
    hasAspectYaml = true;
  } catch {
    // file absent → not an aspect directory at this level; keep recursing
  }

  if (hasAspectYaml && aspectId !== '') {
    await migrateOneAspect(aspectYamlPath, aspectId, actions, warnings);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    await scanAspectsDir(rootDir, path.join(relPath, entry.name), actions, warnings);
  }
}

async function migrateOneAspect(
  aspectYamlPath: string,
  aspectId: string,
  actions: string[],
  warnings: string[],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(aspectYamlPath, 'utf-8');
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(content) as Record<string, unknown>;
  } catch {
    warnings.push(`aspects/${aspectId}/yg-aspect.yaml: parse error — file left unchanged.`);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  // Already-mapping reviewer with `type:` — skip silently for idempotency.
  if (!isLegacyAspectReviewer(parsed) && parsed.reviewer !== undefined && parsed.reviewer !== null) {
    if (typeof parsed.reviewer === 'object' && !Array.isArray(parsed.reviewer)) {
      const r = parsed.reviewer as Record<string, unknown>;
      if ('type' in r) return;
    }
  }

  const result = transformAspectReviewer(parsed);
  for (const w of result.warnings) {
    warnings.push(`aspects/${aspectId}/yg-aspect.yaml: ${w}`);
  }
  if (result.value !== undefined && result.changed) {
    await writeFile(aspectYamlPath, stringifyYaml(result.value, { lineWidth: 0 }), 'utf-8');
    actions.push(`aspects/${aspectId}/yg-aspect.yaml: migrated reviewer to mapping form.`);
  }
}

async function migrateSecretsFile(
  yggRoot: string,
  _actions: string[],
  warnings: string[],
): Promise<void> {
  const findings = await inspectSecretsForValidation(yggRoot);
  if (findings.length === 0) return;
  for (const { provider, foreignKeys } of findings) {
    warnings.push(
      `yg-secrets.yaml: provider '${provider}' has non-credential fields (${foreignKeys.join(', ')}). ` +
        'The secrets file accepts api_key only — move other fields into yg-config.yaml under `reviewer.tiers.<name>.config`. ' +
        'Then re-run `yg init --upgrade`.',
    );
  }
}

// ── main migration ────────────────────────────────────────────

export async function migrateTo50(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  const configOutcome = await migrateConfigFile(yggRoot, actions, warnings);
  if (configOutcome.proceedWithAspects) {
    await migrateAllAspects(yggRoot, actions, warnings);
  }
  await migrateSecretsFile(yggRoot, actions, warnings);
  await addAspectStatusDefaults(yggRoot, warnings);

  const bumpVersion = warnings.length === 0;
  if (bumpVersion) {
    actions.push('Migration complete; the runner will bump yg-config.yaml version to 5.0.0.');
  } else {
    actions.push(
      'Migration partial: warnings emitted. Version will NOT be bumped. ' +
        'Fix the listed files, then re-run `yg init --upgrade`.',
    );
  }

  return { actions, warnings, bumpVersion };
}
