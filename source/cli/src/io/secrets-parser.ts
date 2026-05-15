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
  const partial: Partial<LlmConfig> = {};

  if (raw.api_key !== undefined) {
    if (typeof raw.api_key !== 'string') throw new Error(`${ctx('api_key')}: must be a string`);
    partial.api_key = raw.api_key;
  }
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== 'string') throw new Error(`${ctx('provider')}: must be a string`);
    partial.provider = raw.provider as LlmConfig['provider'];
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string') throw new Error(`${ctx('model')}: must be a string`);
    partial.model = raw.model;
  }
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== 'string') throw new Error(`${ctx('endpoint')}: must be a string`);
    partial.endpoint = raw.endpoint;
  }
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number') throw new Error(`${ctx('temperature')}: must be a number`);
    partial.temperature = raw.temperature;
  }
  if (raw.consensus !== undefined) {
    if (typeof raw.consensus !== 'number') throw new Error(`${ctx('consensus')}: must be a number`);
    partial.consensus = raw.consensus;
  }
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens !== 'number' && raw.max_tokens !== 'auto') {
      throw new Error(`${ctx('max_tokens')}: must be a number or 'auto'`);
    }
    partial.max_tokens = raw.max_tokens as LlmConfig['max_tokens'];
  }

  return Object.keys(partial).length > 0 ? partial : undefined;
}

/** Merge base LLM config with secrets overrides */
export function mergeLlmConfig(base: LlmConfig, secrets: Partial<LlmConfig>): LlmConfig {
  return { ...base, ...secrets };
}
