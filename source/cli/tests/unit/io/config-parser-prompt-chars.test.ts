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
  // The parser is UNCHANGED by v5.2.0: an omitted key still parses to `undefined`.
  // The 50000 default is applied at the size GATE (verify-lock / fill-llm), not here —
  // so this "absent → undefined" assertion stays green.
  it('absent: max_prompt_chars is undefined', async () => {
    const filePath = makeTmpConfig(baseYaml(''));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.max_prompt_chars).toBeUndefined();
  });

  it('invalid value: the guided NEXT no longer promises unlimited and points at the 50000 default', async () => {
    // v5.2.0 dropped the "or remove the key to allow unlimited prompt size" guidance —
    // an omitted key now defaults to 50000, so the message must not promise unlimited.
    const filePath = makeTmpConfig(baseYaml('      max_prompt_chars: -5\n'));
    let caught: unknown;
    try {
      await parseConfig(filePath);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigParseError);
    const next = (caught as ConfigParseError).messageData.next;
    expect(next).not.toMatch(/unlimited/i);
    expect(next).not.toMatch(/remove the key/i);
    expect(next).toContain('50000');
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
