import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';

const tempDirs: string[] = [];

function makeTmpConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yg-config-prompt-chars-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'yg-config.yaml');
  writeFileSync(filePath, yaml, 'utf-8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const baseYaml = (extra: string) => `version: "5.0.0"
reviewer:
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: x
        endpoint: http://localhost:11434
${extra}`;

describe('parseConfig — tier max_prompt_chars', () => {
  it('absent: max_prompt_chars is undefined', async () => {
    const filePath = makeTmpConfig(baseYaml(''));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.max_prompt_chars).toBeUndefined();
  });

  it('valid positive integer is parsed and stored', async () => {
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: 100000\n'));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.max_prompt_chars).toBe(100000);
  });

  it('rejects 0 with config-tier-prompt-chars-invalid', async () => {
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: 0\n'));
    await expect(parseConfig(filePath)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigParseError && e.code === 'config-tier-prompt-chars-invalid'
    );
  });

  it('rejects negative integer with config-tier-prompt-chars-invalid', async () => {
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: -5\n'));
    await expect(parseConfig(filePath)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigParseError && e.code === 'config-tier-prompt-chars-invalid'
    );
  });

  it('rejects fractional number with config-tier-prompt-chars-invalid', async () => {
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: 1.5\n'));
    await expect(parseConfig(filePath)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigParseError && e.code === 'config-tier-prompt-chars-invalid'
    );
  });

  it('rejects string "50000" with config-tier-prompt-chars-invalid', async () => {
    // YAML bare string (quoted to ensure it is a string type)
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: "50000"\n'));
    await expect(parseConfig(filePath)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigParseError && e.code === 'config-tier-prompt-chars-invalid'
    );
  });

  it('rejects null with config-tier-prompt-chars-invalid', async () => {
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: null\n'));
    await expect(parseConfig(filePath)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConfigParseError && e.code === 'config-tier-prompt-chars-invalid'
    );
  });
});
