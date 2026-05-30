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

describe('parseAspect — references parser-phase validation', () => {
  it('aspect-references-on-deterministic: references on deterministic aspect → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: deterministic }
references:
  - x.md
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-references-on-deterministic');
  });

  it('aspect-reference-blank-path: empty string path → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - ""
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-blank-path');
  });

  it('aspect-reference-blank-path: whitespace-only path → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - "   "
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-blank-path');
  });

  it('aspect-reference-escape: leading slash → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - /etc/passwd
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-escape');
  });

  it('aspect-reference-escape: Windows drive letter → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - "C:\\\\Windows\\\\system32"
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-escape');
  });

  it('aspect-reference-escape: tilde → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - ~/secret
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-escape');
  });

  it('aspect-reference-escape: ..-escape above repo root → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - "../../etc/passwd"
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-escape');
  });

  it('inner ..-segments that do NOT escape are allowed', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - "docs/sub/../error-codes.md"
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
  });

  it('aspect-reference-duplicate: same normalized path twice → error', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references:
  - docs/x.md
  - docs/x.md
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('aspect-reference-duplicate');
  });

  it('aspect-references-empty-array: empty list → parser accepts (warning is validator-phase)', async () => {
    const dir = makeAspectDir(`name: T
reviewer: { type: llm }
references: []
`);
    const result = await parseAspect(dir, join(dir, 'yg-aspect.yaml'), 't');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aspect.references).toEqual([]);
    // warning is surfaced by validator phase (Task 6); parser accepts.
  });
});
