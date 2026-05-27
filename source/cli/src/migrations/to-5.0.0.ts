import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';
import { updateConfigVersion } from '../core/migrator.js';
import { KNOWN_PROVIDERS } from '../io/config-parser.js';

const PROVIDER_SET = new Set<string>(KNOWN_PROVIDERS);

// ── config transform ─────────────────────────────────────────

/** v4 reviewer block → v5 tiers block. Returns undefined if already v5. */
export function transformConfigReviewer(
  reviewer: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Already v5 (has tiers or default key)
  if ('tiers' in reviewer || 'default' in reviewer) return undefined;

  // Not v4 either — nothing to do
  const hasActive = 'active' in reviewer;
  const providerKeys = Object.keys(reviewer).filter(k => PROVIDER_SET.has(k));
  if (!hasActive && providerKeys.length === 0) return undefined;

  // Determine the single active provider
  let activeProvider: string | undefined;
  if (hasActive && typeof reviewer.active === 'string') {
    activeProvider = reviewer.active;
  } else if (providerKeys.length === 1) {
    activeProvider = providerKeys[0];
  } else if (providerKeys.length > 1) {
    // Ambiguous: pick first alphabetically as a best-effort, emit in warnings
    activeProvider = providerKeys[0];
  }

  if (!activeProvider) return undefined;

  const consensusRaw = typeof reviewer.consensus === 'number' ? reviewer.consensus : 1;
  const providerConfig = (reviewer[activeProvider] ?? {}) as Record<string, unknown>;

  // Strip non-config keys from the provider block
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(providerConfig)) {
    config[k] = v;
  }

  return {
    tiers: {
      standard: {
        provider: activeProvider,
        consensus: consensusRaw,
        config,
      },
    },
  };
}

// ── aspect transform ─────────────────────────────────────────

const AST_STRINGS = new Set(['ast']);

/** v4 string reviewer → v5 object reviewer. Returns undefined if already object. */
export function transformAspectReviewer(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const reviewer = raw.reviewer;
  if (typeof reviewer !== 'string') return undefined; // already object form or absent

  const type = AST_STRINGS.has(reviewer) ? 'ast' : 'llm';
  return { ...raw, reviewer: { type } };
}

// ── main migration ───────────────────────────────────────────

export async function migrateTo50(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];

  // 1. Transform yg-config.yaml reviewer section
  const configPath = path.join(yggRoot, 'yg-config.yaml');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    if (parsed?.reviewer && typeof parsed.reviewer === 'object' && !Array.isArray(parsed.reviewer)) {
      const newReviewer = transformConfigReviewer(parsed.reviewer as Record<string, unknown>);
      if (newReviewer) {
        const providerKeys = Object.keys(parsed.reviewer as Record<string, unknown>)
          .filter(k => PROVIDER_SET.has(k));
        if (providerKeys.length > 1) {
          warnings.push(
            `reviewer: had multiple providers (${providerKeys.join(', ')}); migrated active provider only. ` +
            'Add additional tiers to reviewer.tiers manually if needed.',
          );
        }
        parsed.reviewer = newReviewer;
        await writeFile(configPath, stringifyYaml(parsed, { lineWidth: 0 }), 'utf-8');
        actions.push('yg-config.yaml: migrated reviewer: from v4 format to v5 tiers');
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    warnings.push('yg-config.yaml not found — reviewer config migration skipped');
  }

  // 2. Transform yg-aspect.yaml files (reviewer: string → reviewer: { type: ... })
  const aspectsDir = path.join(yggRoot, 'aspects');
  try {
    const entries = await readdir(aspectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const aspectYamlPath = path.join(aspectsDir, entry.name, 'yg-aspect.yaml');
      let content: string;
      try {
        content = await readFile(aspectYamlPath, 'utf-8');
      } catch {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = parseYaml(content) as Record<string, unknown>;
      } catch {
        warnings.push(`aspects/${entry.name}/yg-aspect.yaml: parse error — skipped`);
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const updated = transformAspectReviewer(parsed);
      if (updated) {
        await writeFile(aspectYamlPath, stringifyYaml(updated, { lineWidth: 0 }), 'utf-8');
        actions.push(`aspects/${entry.name}/yg-aspect.yaml: migrated reviewer: string to object form`);
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    // no aspects/ dir — nothing to do
  }

  // 3. Bump version
  if (actions.length > 0) {
    try {
      await updateConfigVersion(yggRoot, '5.0.0');
      actions.push('Updated yg-config.yaml: version → 5.0.0');
    } catch {
      warnings.push('yg-config.yaml not found — version not updated to 5.0.0');
    }
  }

  if (actions.length > 0) {
    warnings.push(
      `Migrated to schema 5.0.0. New reviewer format:
  - reviewer: in yg-config.yaml now uses reviewer.tiers (named tier blocks)
  - Each tier declares: provider, consensus, config: { model, ... }
  - Aspects declare reviewer: { type: llm } or reviewer: { type: ast }
  - Use reviewer.tiers.<name>.tier: in aspects to target specific tiers

See: yg knowledge read configuration`,
    );
  }

  return { actions, warnings };
}
