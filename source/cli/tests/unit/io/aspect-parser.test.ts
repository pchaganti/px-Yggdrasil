import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAspect } from '../../../src/io/aspect-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  __dirname,
  '../../fixtures/sample-project/.yggdrasil/aspects/requires-audit',
);

describe('aspect-parser', () => {
  it('parses valid yg-aspect.yaml correctly', async () => {
    const aspect = await parseAspect(
      path.join(FIXTURE_DIR),
      path.join(FIXTURE_DIR, 'yg-aspect.yaml'),
      'requires-audit',
    );

    expect(aspect.name).toBe('Audit Logging');
    expect(aspect.id).toBe('requires-audit');
    expect(aspect.artifacts).toBeDefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, '', 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'empty-aspect')).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(badPath, `implies: []\n`, 'utf-8');

    await expect(parseAspect(tmpDir, badPath, 'some-aspect')).rejects.toThrow(
      "missing or empty 'name'",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses id from directory path (3rd parameter)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-tag');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: My Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'my-directory-name');
    expect(aspect.id).toBe('my-directory-name');
    expect(aspect.name).toBe('My Aspect');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses implies when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: HIPAA
implies:
  - requires-audit
  - requires-encryption
`,
      'utf-8',
    );
    const aspect = await parseAspect(tmpDir, aspectPath, 'requires-hipaa');
    expect(aspect.id).toBe('requires-hipaa');
    expect(aspect.implies).toEqual(['requires-audit', 'requires-encryption']);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when id is empty', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-empty-id');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\n`, 'utf-8');

    await expect(parseAspect(tmpDir, aspectPath, '')).rejects.toThrow(
      'aspect id must be non-empty',
    );
    await expect(parseAspect(tmpDir, aspectPath, '   ')).rejects.toThrow(
      'aspect id must be non-empty',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when implies is not an array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-bad-implies');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nimplies: "not-an-array"\n`, 'utf-8');

    await expect(parseAspect(tmpDir, aspectPath, 'bad-implies')).rejects.toThrow(
      "'implies' must be an array",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults optional fields when missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Minimal Aspect\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'minimal-aspect');
    expect(aspect.name).toBe('Minimal Aspect');
    expect(aspect.id).toBe('minimal-aspect');
    expect(aspect.artifacts).toEqual([]);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown stability field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-stability');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Stable Aspect\nstability: protocol\n`, 'utf-8');

    const aspect = await parseAspect(tmpDir, aspectPath, 'stable');
    // unknown field should not throw
    expect(aspect.name).toBe('Stable Aspect');
    expect((aspect as Record<string, unknown>).stability).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when reviewer is invalid value', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-bad-reviewer');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectPath, `name: Test\nreviewer: invalid\n`, 'utf-8');

    await expect(parseAspect(tmpDir, aspectPath, 'test')).rejects.toThrow(
      "'reviewer' must be 'ast' or 'llm'",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('silently ignores unknown anchors field', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-anchors');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Logging
anchors:
  - id: audit-entry
    claim: "All mutations record an audit entry"
`,
      'utf-8',
    );

    const aspect = await parseAspect(tmpDir, aspectPath, 'logging');
    expect(aspect.name).toBe('Logging');
    expect((aspect as Record<string, unknown>).anchors).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses all optional fields together', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-full');
    await mkdir(tmpDir, { recursive: true });
    const aspectPath = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(
      aspectPath,
      `name: Full Aspect
description: A fully specified aspect
implies:
  - other-aspect
`,
      'utf-8',
    );

    const aspect = await parseAspect(tmpDir, aspectPath, 'full-aspect');
    expect(aspect.name).toBe('Full Aspect');
    expect(aspect.description).toBe('A fully specified aspect');
    expect(aspect.implies).toEqual(['other-aspect']);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('aspect-parser — when filter', () => {
  it('parses top-level when', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-when');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'when:',
      '  relations:',
      '    calls:',
      '      target_type: service-client',
    ].join('\n'), 'utf-8');

    const result = await parseAspect(tmpDir, aspectYaml, 'example');
    expect(result.when).toEqual({
      relations: { calls: { target_type: 'service-client' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses implies with object form and per-implies when', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies-when');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'implies:',
      '  - simple-aspect',
      '  - id: conditional-aspect',
      '    when:',
      '      node: { has_port: charge }',
    ].join('\n'), 'utf-8');

    const result = await parseAspect(tmpDir, aspectYaml, 'example');
    expect(result.implies).toEqual(['simple-aspect', 'conditional-aspect']);
    expect(result.impliesWhens).toEqual({
      'conditional-aspect': { node: { has_port: 'charge' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid when at aspect level', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-when-bad');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'when:',
      '  mostly_of: []',
    ].join('\n'), 'utf-8');

    await expect(parseAspect(tmpDir, aspectYaml, 'example'))
      .rejects.toThrow(/unknown when operator 'mostly_of'/);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-string non-object entries in implies', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-aspect-implies-bad');
    await mkdir(tmpDir, { recursive: true });
    const aspectYaml = path.join(tmpDir, 'yg-aspect.yaml');
    await writeFile(aspectYaml, [
      'name: ExampleAspect',
      'implies:',
      '  - 42',
    ].join('\n'), 'utf-8');

    await expect(parseAspect(tmpDir, aspectYaml, 'example'))
      .rejects.toThrow(/aspect attachment must be a string or an object/);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
