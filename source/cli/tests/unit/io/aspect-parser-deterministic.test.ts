import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';

// Phase 4: reviewer.type collapses to { llm, deterministic }. The former 'ast'
// and 'structure' literals are gone — both ran the same local check.mjs path.
// These tests pin the new vocabulary at the parser boundary.
describe('aspect-parser — deterministic reviewer.type', () => {
  let root: string;
  let aspectDir: string;
  let yamlPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-aspect-parser-deterministic-'));
    aspectDir = path.join(root, 'test');
    mkdirSync(aspectDir, { recursive: true });
    yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts reviewer.type: deterministic', async () => {
    writeFileSync(yamlPath, 'name: T\ndescription: x\nreviewer:\n  type: deterministic\n');
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspect.reviewer.type).toBe('deterministic');
  });

  it('rejects the retired reviewer.type: ast', async () => {
    writeFileSync(yamlPath, 'name: T\ndescription: x\nreviewer:\n  type: ast\n');
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-type-invalid')).toBe(true);
  });

  it('rejects the retired reviewer.type: structure', async () => {
    writeFileSync(yamlPath, 'name: T\ndescription: x\nreviewer:\n  type: structure\n');
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'aspect-reviewer-type-invalid')).toBe(true);
  });

  it('rejects references on a deterministic aspect — aspect-references-on-deterministic', async () => {
    writeFileSync(yamlPath, [
      'name: T',
      'description: x',
      'reviewer:',
      '  type: deterministic',
      'references:',
      '  - docs/foo.md',
      '',
    ].join('\n'));
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('aspect-references-on-deterministic');
  });

  it('rejects reviewer.tier on a deterministic aspect — aspect-tier-on-deterministic', async () => {
    writeFileSync(yamlPath, [
      'name: T',
      'description: x',
      'reviewer:',
      '  type: deterministic',
      '  tier: deep',
      '',
    ].join('\n'));
    const r = await parseAspect(aspectDir, yamlPath, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('aspect-tier-on-deterministic');
  });
});
