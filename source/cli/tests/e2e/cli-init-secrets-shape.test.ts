import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { writeReviewerConfig, writeSecretsFile, needsApiKey } from '../../src/cli/init.js';
import { parseConfig } from '../../src/io/config-parser.js';
import { resolveApiKey } from '../../src/llm/api-utils.js';
import { KNOWN_PROVIDERS } from '../../src/utils/known-providers.js';
import { DEFAULT_CONFIG, DEFAULT_ARCHITECTURE } from '../../src/templates/default-config.js';
import type { ReviewerProvider } from '../../src/model/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: result.status, all: (result.stdout ?? '') + (result.stderr ?? '') };
}

// Every provider that requires an API key — derived from the single source of
// truth (`needsApiKey`) over the full provider list, so a newly added key-
// requiring provider is covered automatically. Today: openai, anthropic,
// google, openai-compatible (CLI agents and local Ollama need no key).
const KEY_PROVIDERS = KNOWN_PROVIDERS.filter((p) => needsApiKey(p as ReviewerProvider));

/**
 * Reproduce `yg init`'s on-disk output for one provider, minus the interactive
 * prompts: the DEFAULT_CONFIG + DEFAULT_ARCHITECTURE skeleton, the model/aspects/
 * flows dirs, then the real writeReviewerConfig + writeSecretsFile writers.
 * Returns the project root (parent of .yggdrasil).
 */
async function initLikeProject(provider: ReviewerProvider, apiKey: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), `yg-init-secrets-${provider}-`));
  const yggRoot = path.join(root, '.yggdrasil');
  mkdirSync(path.join(yggRoot, 'model'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'aspects'), { recursive: true });
  mkdirSync(path.join(yggRoot, 'flows'), { recursive: true });
  writeFileSync(path.join(yggRoot, 'yg-config.yaml'), DEFAULT_CONFIG, 'utf-8');
  writeFileSync(path.join(yggRoot, 'yg-architecture.yaml'), DEFAULT_ARCHITECTURE, 'utf-8');

  // `openai-compatible` has no default host — the tier requires an explicit endpoint.
  const endpoint = provider === 'openai-compatible' ? 'https://example.test/v1' : undefined;
  await writeReviewerConfig(yggRoot, { provider, model: 'test-model', endpoint });
  await writeSecretsFile(yggRoot, apiKey);
  return root;
}

describe.skipIf(!distExists)('yg init — API-key secrets shape (1:1 overlay, per key-requiring provider)', () => {
  it('covers every key-requiring provider', () => {
    expect(KEY_PROVIDERS).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'google', 'openai-compatible']),
    );
  });

  it.each(KEY_PROVIDERS)(
    'writes the %s key into reviewer.tiers.<name>.config.api_key so yg check parses and the key resolves',
    async (provider) => {
      const apiKey = `sk-${provider}-secret-xyz`;
      const root = await initLikeProject(provider as ReviewerProvider, apiKey);
      try {
        const yggRoot = path.join(root, '.yggdrasil');

        // 1. yg-secrets.yaml is a 1:1 overlay over yg-config.yaml: the key lives
        //    inside the tier's config: block, NOT under a provider-level bucket.
        const secrets = parseYaml(readFileSync(path.join(yggRoot, 'yg-secrets.yaml'), 'utf-8'));
        expect(secrets.reviewer.tiers.standard.config.api_key).toBe(apiKey);
        expect(secrets.reviewer[provider]).toBeUndefined();

        // 2. The real `yg check` parses the merged (config + secrets) shape — no
        //    config-reviewer-unknown-key, clean exit.
        const res = run(['check'], root);
        expect(res.all).not.toContain('config-reviewer-unknown-key');
        expect(res.status).toBe(0);

        // 3. The key is actually plumbed into the resolved tier (not silently
        //    dropped, leaving only the env-var fallback).
        const config = await parseConfig(path.join(yggRoot, 'yg-config.yaml'));
        const tier = config.reviewer!.tiers.standard;
        expect(resolveApiKey(tier)).toBe(apiKey);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
