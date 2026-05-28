import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, '../../fixtures/tmp-arch-status');

async function writeArchFixture(yaml: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const p = path.join(TMP, 'yg-architecture.yaml');
  await writeFile(p, yaml, 'utf-8');
  return p;
}

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('architecture-parser: aspect status', () => {
  it('bare aspect → no status override', async () => {
    const p = await writeArchFixture(`
node_types:
  command:
    description: CLI command
    aspects:
      - cli-contract
`);
    const arch = await parseArchitecture(p);
    expect(arch.node_types.command.aspects).toEqual(['cli-contract']);
    expect(arch.node_types.command.aspectStatus).toBeUndefined();
  });

  it('object form with status', async () => {
    const p = await writeArchFixture(`
node_types:
  command:
    description: CLI command
    aspects:
      - id: cli-contract
        status: enforced
`);
    const arch = await parseArchitecture(p);
    expect(arch.node_types.command.aspectStatus?.['cli-contract']).toBe('enforced');
  });
});
