import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAspect } from '../../../src/io/aspect-parser.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeAspectDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yg-aspect-test-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'yg-aspect.yaml'), yaml, 'utf-8');
  writeFileSync(join(dir, 'content.md'), '# Rule\n', 'utf-8');
  return dir;
}

describe('parseAspect — references shorthand and explicit forms', () => {
  it('normalizes string shorthand to { path, description: undefined }', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - docs/error-codes.md
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references).toEqual([
      { path: 'docs/error-codes.md', description: undefined },
    ]);
  });

  it('keeps explicit object form with description', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - path: source/x.ts
    description: catalogue
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references).toEqual([
      { path: 'source/x.ts', description: 'catalogue' },
    ]);
  });

  it('preserves declaration order across mixed forms', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - a.md
  - { path: b.md, description: B }
  - c.md
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references?.map(r => r.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('absent references field → result.aspect.references is undefined', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references).toBeUndefined();
  });
});
