// Parser-adapter — reads the user's `yg-secrets.yaml` from disk and parses it.
// Lives in `io/` because it touches the filesystem. Yields a structured config fragment.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LlmConfig } from '../model/graph.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * Load yg-secrets.yaml from .yggdrasil/ and extract reviewer secrets.
 * Returns partial LLM config with only fields present in secrets file.
 *
 * Silent (returns undefined) when:
 *   - file does not exist
 *   - file is empty
 *   - top-level has no `reviewer:` mapping
 *   - `providerName` is omitted
 *   - no provider section matches `providerName`
 *   - provider section has no recognized fields
 *
 * Throws (with file path + field name) when structure exists but types are wrong:
 *   - top-level is not a YAML mapping
 *   - `reviewer` is present but not a mapping
 *   - `reviewer.<provider>` is present but not a mapping
 *   - a known secret field is present with the wrong type
 */
export async function loadSecrets(rootPath: string, providerName?: string): Promise<Partial<LlmConfig> | undefined> {
  const secretsPath = join(rootPath, 'yg-secrets.yaml');
  let content: string;
  try {
    content = await readFile(secretsPath, 'utf-8');
  } catch (err) {
    debugWrite(`[secrets-parser] readFile: ${(err as Error).message}`);
    return undefined;
  }

  const raw = parseYaml(content) as Record<string, unknown>;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`yg-secrets.yaml: top level must be a YAML mapping`);
  }

  const rawObj = raw;
  if (rawObj.reviewer === undefined) return undefined;
  if (typeof rawObj.reviewer !== 'object' || rawObj.reviewer === null || Array.isArray(rawObj.reviewer)) {
    throw new Error(`yg-secrets.yaml: 'reviewer' must be a YAML mapping`);
  }

  if (!providerName) return undefined;

  const reviewerRaw = rawObj.reviewer as Record<string, unknown>;
  const providerSection = reviewerRaw[providerName];
  if (providerSection === undefined) return undefined;
  if (typeof providerSection !== 'object' || providerSection === null || Array.isArray(providerSection)) {
    throw new Error(`yg-secrets.yaml: 'reviewer.${providerName}' must be a YAML mapping`);
  }

  return extractSecretFields(providerSection as Record<string, unknown>, providerName);
}

function extractSecretFields(raw: Record<string, unknown>, providerName: string): Partial<LlmConfig> | undefined {
  const ctx = (field: string) => `yg-secrets.yaml at reviewer.${providerName}.${field}`;
  if (raw.api_key !== undefined) {
    if (typeof raw.api_key !== 'string') throw new Error(`${ctx('api_key')}: must be a string`);
    if (raw.api_key.trim() !== '') {
      return { api_key: raw.api_key };
    }
  }
  return undefined;
}

/** Merge base LLM config with secrets overrides */
export function mergeLlmConfig(base: LlmConfig, secrets: Partial<LlmConfig>): LlmConfig {
  return { ...base, ...secrets };
}

/**
 * Inspect yg-secrets.yaml for non-credential fields (any key other than api_key).
 * Used by the validator to emit `secrets-non-credential-field` errors.
 * Returns empty array when file does not exist or has no violations.
 */
export async function inspectSecretsForValidation(
  rootPath: string,
): Promise<Array<{ provider: string; foreignKeys: string[] }>> {
  const secretsPath = join(rootPath, 'yg-secrets.yaml');
  let content: string;
  try {
    content = await readFile(secretsPath, 'utf-8');
  } catch {
    return [];
  }
  const raw = parseYaml(content) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  if (!raw.reviewer || typeof raw.reviewer !== 'object' || Array.isArray(raw.reviewer)) return [];

  const reviewerRaw = raw.reviewer as Record<string, unknown>;
  const results: Array<{ provider: string; foreignKeys: string[] }> = [];

  for (const [provider, section] of Object.entries(reviewerRaw)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const sectionObj = section as Record<string, unknown>;
    const foreignKeys = Object.keys(sectionObj).filter((k) => k !== 'api_key');
    if (foreignKeys.length > 0) {
      results.push({ provider, foreignKeys });
    }
  }
  return results;
}
