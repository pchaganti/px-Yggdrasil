import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAspect } from '../../../src/io/aspect-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(__dirname, '../../fixtures/tmp-aspect-status');

async function writeAspectFixture(yaml: string): Promise<{ aspectDir: string; yamlPath: string }> {
  const aspectDir = path.join(TMP_ROOT, 'example');
  await mkdir(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  await writeFile(yamlPath, yaml, 'utf-8');
  await writeFile(path.join(aspectDir, 'content.md'), 'rule', 'utf-8');
  return { aspectDir, yamlPath };
}

afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe('aspect-parser: status field', () => {
  it('accepts status: enforced', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: enforced
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('enforced');
  });

  it('accepts status: advisory', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: advisory
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('advisory');
  });

  it('accepts status: draft', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: draft
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBe('draft');
  });

  it('absent status field → undefined (resolver applies enforced default)', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.status).toBeUndefined();
  });

  it('rejects invalid status value', async () => {
    const { aspectDir, yamlPath } = await writeAspectFixture(`
name: Example
description: x
reviewer: { type: llm }
status: unstable
`);
    const r = await parseAspect(aspectDir, yamlPath, 'example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map(e => e.code)).toContain('aspect-status-invalid');
    }
  });
});
