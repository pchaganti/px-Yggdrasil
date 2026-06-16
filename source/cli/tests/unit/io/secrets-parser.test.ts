import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, loadConfigOverlay } from '../../../src/io/secrets-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-overlay'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('deepMerge', () => {
  it('overlay scalar wins over base scalar', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('recurses into nested mappings', () => {
    const base = { reviewer: { tiers: { standard: { provider: 'claude-code', config: { model: 'sonnet' } } } } };
    const overlay = { reviewer: { tiers: { standard: { provider: 'ollama', config: { endpoint: 'http://h:11434' } } } } };
    expect(deepMerge(base, overlay)).toEqual({
      reviewer: { tiers: { standard: { provider: 'ollama', config: { model: 'sonnet', endpoint: 'http://h:11434' } } } },
    });
  });

  it('overlay adds keys absent from base', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('arrays are replaced wholesale, not concatenated', () => {
    expect(deepMerge({ xs: [1, 2, 3] }, { xs: [9] })).toEqual({ xs: [9] });
  });

  it('mismatched types: overlay wins (object replaces scalar and vice versa)', () => {
    expect(deepMerge({ a: 1 }, { a: { nested: true } })).toEqual({ a: { nested: true } });
    expect(deepMerge({ a: { nested: true } }, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate its inputs', () => {
    const base = { a: { x: 1 } };
    const overlay = { a: { y: 2 } };
    deepMerge(base, overlay);
    expect(base).toEqual({ a: { x: 1 } });
    expect(overlay).toEqual({ a: { y: 2 } });
  });
});

describe('loadConfigOverlay', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await loadConfigOverlay('/nonexistent/path/that/does/not/exist')).toBeUndefined();
  });

  it('returns undefined when the file is empty', async () => {
    const yggDir = path.join(FIXTURES_DIR, 'tmp-overlay-empty');
    await mkdir(yggDir, { recursive: true });
    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), '', 'utf-8');
    expect(await loadConfigOverlay(yggDir)).toBeUndefined();
  });

  it('returns the parsed mapping (any field, not just api_key)', async () => {
    const yggDir = path.join(FIXTURES_DIR, 'tmp-overlay-full');
    await mkdir(yggDir, { recursive: true });
    await writeFile(
      path.join(yggDir, 'yg-secrets.yaml'),
      `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      config:\n        model: qwen3\n        endpoint: http://host.docker.internal:11434\n`,
      'utf-8',
    );
    const overlay = await loadConfigOverlay(yggDir);
    expect(overlay).toEqual({
      reviewer: { tiers: { standard: { provider: 'ollama', config: { model: 'qwen3', endpoint: 'http://host.docker.internal:11434' } } } },
    });
  });

  it('throws when the top level is not a YAML mapping', async () => {
    const yggDir = path.join(FIXTURES_DIR, 'tmp-overlay-array');
    await mkdir(yggDir, { recursive: true });
    await writeFile(path.join(yggDir, 'yg-secrets.yaml'), `- one\n- two\n`, 'utf-8');
    await expect(loadConfigOverlay(yggDir)).rejects.toThrow(/top level must be a YAML mapping/);
  });
});
