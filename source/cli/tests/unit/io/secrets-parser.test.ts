import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, mergeLlmConfig } from '../../../src/io/secrets-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-secrets'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('secrets-parser', () => {
  it('loads api_key from secrets and merges with config', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-api-key');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-test-123
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.api_key).toBe('sk-test-123');

    const baseConfig = {
      provider: 'ollama' as const,
      model: 'llama3.1:8b',
      temperature: 0,
      consensus: 1,
      max_tokens: 'auto' as const,
    };
    const merged = mergeLlmConfig(baseConfig, secrets!);
    expect(merged.api_key).toBe('sk-test-123');
    expect(merged.provider).toBe('ollama'); // from base, not overridden

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when no secrets file exists', async () => {
    const nonexistentPath = '/nonexistent/path/that/does/not/exist';
    const secrets = await loadSecrets(nonexistentPath);
    expect(secrets).toBeUndefined();
  });

  it('secrets override base config fields', async () => {
    const baseConfig = {
      provider: 'ollama' as const,
      model: 'llama3.1:8b',
      temperature: 0,
      consensus: 1,
      max_tokens: 'auto' as const,
    };
    const secretsOverrides = {
      provider: 'claude-code' as const,
      api_key: 'sk-123',
    };
    const merged = mergeLlmConfig(baseConfig, secretsOverrides);
    expect(merged.provider).toBe('claude-code');
    expect(merged.model).toBe('llama3.1:8b'); // not overridden
    expect(merged.api_key).toBe('sk-123');
  });

  it('returns undefined when secrets file has no reviewer section', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-no-reviewer');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
other_config: value
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when reviewer section is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-empty-reviewer');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer: {}
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads provider fields from reviewer secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    model: qwen3
    consensus: 3
    max_tokens: 4096
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.model).toBe('qwen3');
    expect(secrets?.consensus).toBe(3);
    expect(secrets?.max_tokens).toBe(4096);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads multiple fields from reviewer secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-multiple');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-test-456
    endpoint: https://api.example.com
    temperature: 0.5
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.api_key).toBe('sk-test-456');
    expect(secrets?.endpoint).toBe('https://api.example.com');
    expect(secrets?.temperature).toBe(0.5);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when provider key not in secrets', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-wrong-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-123
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'claude-code');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when secrets YAML is empty (null parse result)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-empty-file');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), '', 'utf-8');

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when providerName is omitted', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-default-provider');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    api_key: sk-default-test
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir); // no providerName — returns undefined
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when provider section has no recognized fields', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-no-known-fields');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    unknown_field: some_value
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts provider field from secrets when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider-field');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });

    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `
reviewer:
  ollama:
    provider: claude-code
    model: haiku
`,
      'utf-8',
    );

    const secrets = await loadSecrets(yggDir, 'ollama');
    expect(secrets?.provider).toBe('claude-code');
    expect(secrets?.model).toBe('haiku');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when top level is not a YAML mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-top-level-array');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), `- one\n- two\n`, 'utf-8');

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/top level must be a YAML mapping/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when reviewer is present but not a mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-reviewer-string');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), `reviewer: "not an object"\n`, 'utf-8');

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/'reviewer' must be a YAML mapping/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when provider section is not a mapping', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-provider-string');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `reviewer:\n  ollama: "not a section"\n`,
      'utf-8',
    );

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/'reviewer\.ollama' must be a YAML mapping/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when api_key is not a string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-bad-api-key');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `reviewer:\n  ollama:\n    api_key: 42\n`,
      'utf-8',
    );

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/reviewer\.ollama\.api_key: must be a string/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when temperature is not a number', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-bad-temp');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `reviewer:\n  ollama:\n    temperature: "hot"\n`,
      'utf-8',
    );

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/reviewer\.ollama\.temperature: must be a number/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when max_tokens is neither a number nor "auto"', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-secrets-bad-max-tokens');
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(yggDir, { recursive: true });
    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `reviewer:\n  ollama:\n    max_tokens: "big"\n`,
      'utf-8',
    );

    await expect(loadSecrets(yggDir, 'ollama')).rejects.toThrow(/reviewer\.ollama\.max_tokens: must be a number or 'auto'/);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
