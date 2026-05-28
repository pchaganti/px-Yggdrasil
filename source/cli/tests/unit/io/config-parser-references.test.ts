import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';

const tempDirs: string[] = [];

function makeTmpConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yg-config-refs-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'yg-config.yaml');
  writeFileSync(filePath, yaml, 'utf-8');
  return filePath;
}

const baseYaml = (extra: string) => `version: "5.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config:
        model: x
        endpoint: http://localhost:11434
${extra}`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseConfig — tier references', () => {
  it('absent: tier.references is undefined', async () => {
    const filePath = makeTmpConfig(baseYaml(''));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.references).toBeUndefined();
  });

  it('present with both keys: parsed as-is', async () => {
    const filePath = makeTmpConfig(baseYaml(`      references:
        max_bytes_per_file: 32768
        max_total_bytes_per_aspect: 131072
`));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.references).toEqual({
      max_bytes_per_file: 32768,
      max_total_bytes_per_aspect: 131072,
    });
  });

  it('present with one key: only that key populated', async () => {
    const filePath = makeTmpConfig(baseYaml(`      references:
        max_bytes_per_file: 8192
`));
    const config = await parseConfig(filePath);
    expect(config.reviewer?.tiers.standard.references).toEqual({
      max_bytes_per_file: 8192,
    });
  });

  it('max_bytes_per_file not a positive integer → error', async () => {
    const filePath = makeTmpConfig(baseYaml(`      references:
        max_bytes_per_file: -1
`));
    await expect(parseConfig(filePath)).rejects.toMatchObject({
      code: 'tier-references-max-bytes-per-file-invalid',
    });
  });

  it('max_total_bytes_per_aspect not a positive integer → error', async () => {
    const filePath = makeTmpConfig(baseYaml(`      references:
        max_total_bytes_per_aspect: 0
`));
    await expect(parseConfig(filePath)).rejects.toMatchObject({
      code: 'tier-references-max-total-bytes-invalid',
    });
  });

  it('unknown key under references → error', async () => {
    const filePath = makeTmpConfig(baseYaml(`      references:
        max_giraffes: 5
`));
    await expect(parseConfig(filePath)).rejects.toMatchObject({
      code: 'tier-references-unknown-key',
    });
  });
});
