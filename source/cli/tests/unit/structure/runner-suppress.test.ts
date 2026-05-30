import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { buildTestGraphForStructure } from '../helpers/build-test-graph-structure.js';

describe('runStructureAspect — yg-suppress filtering', () => {
  let projectRoot: string;
  let cbCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'yg-structure-suppress-'));
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function writeAspect(aspectId: string, checkBody: string): Promise<string> {
    cbCounter += 1;
    const aspectDir = path.join(projectRoot, '.yggdrasil', 'aspects', aspectId);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(path.join(aspectDir, 'check.mjs'), `// cb=${cbCounter}\n${checkBody}`);
    return aspectDir;
  }

  it('suppresses a violation on the line after a matching yg-suppress marker', async () => {
    // Marker on line 1 suppresses line 2 for aspect 'sup1'. Reason is required.
    writeFileSync(
      path.join(projectRoot, 'src/a.ts'),
      [
        '// yg-suppress(sup1) deliberate waiver for test',
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
      ].join('\n'),
    );
    await writeAspect('sup1', `export function check(ctx) {
      const f = ctx.files.find(x => x.path.endsWith('.ts'));
      return [
        { message: 'on suppressed line', file: f.path, line: 2 },
        { message: 'on clean line', file: f.path, line: 5 },
      ];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const result = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/sup1'),
      aspectId: 'sup1', nodePath: 'N', graph: g, projectRoot,
    });
    expect(result.violations.map(v => v.message)).toEqual(['on clean line']);
  });

  it('does not suppress when the marker names a different aspect id', async () => {
    // Marker scoped to 'other-rule'; we run aspect 'sup1' → neither violation suppressed.
    writeFileSync(
      path.join(projectRoot, 'src/a.ts'),
      [
        '// yg-suppress(other-rule) reason here',
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
      ].join('\n'),
    );
    await writeAspect('sup1', `export function check(ctx) {
      const f = ctx.files.find(x => x.path.endsWith('.ts'));
      return [
        { message: 'on suppressed line', file: f.path, line: 2 },
        { message: 'on clean line', file: f.path, line: 5 },
      ];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const result = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/sup1'),
      aspectId: 'sup1', nodePath: 'N', graph: g, projectRoot,
    });
    expect(result.violations.map(v => v.message)).toEqual([
      'on suppressed line',
      'on clean line',
    ]);
  });

  it('passes through a graph-level violation (no file/line) untouched', async () => {
    // Marker still scoped to 'sup1' on line 1; a graph-level violation has no
    // file/line, so it cannot be suppressed and must survive.
    writeFileSync(
      path.join(projectRoot, 'src/a.ts'),
      [
        '// yg-suppress(sup1) deliberate waiver for test',
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
      ].join('\n'),
    );
    await writeAspect('sup1', `export function check(ctx) {
      const f = ctx.files.find(x => x.path.endsWith('.ts'));
      return [
        { message: 'on suppressed line', file: f.path, line: 2 },
        { message: 'graph-level' },
      ];
    }`);
    const g = buildTestGraphForStructure({
      nodes: [{ path: 'N', type: 'module', mapping: ['src/a.ts'] }],
    });
    const result = await runStructureAspect({
      aspectDir: path.join('.yggdrasil/aspects/sup1'),
      aspectId: 'sup1', nodePath: 'N', graph: g, projectRoot,
    });
    expect(result.violations.map(v => v.message)).toEqual(['graph-level']);
  });
});
