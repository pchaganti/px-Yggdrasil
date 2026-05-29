import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

describe('aspect-parser — structure reviewer.type', () => {
  let root: string;
  let aspectDir: string;
  let yamlPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-aspect-parser-structure-'));
    aspectDir = path.join(root, 'test');
    mkdirSync(aspectDir, { recursive: true });
    yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts reviewer.type: structure', async () => {
    writeFileSync(yamlPath, 'name: T\ndescription: x\nreviewer:\n  type: structure\n');
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('structure');
  });

  it('rejects structure aspect with references — aspect-references-on-structure', async () => {
    writeFileSync(yamlPath, [
      'name: T',
      'description: x',
      'reviewer:',
      '  type: structure',
      'references:',
      '  - docs/foo.md',
      ''
    ].join('\n'));
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe('aspect-references-on-structure');
    }
  });
});
