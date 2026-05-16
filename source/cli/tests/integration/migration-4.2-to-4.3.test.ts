import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/core/migrator.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

describe('4.2.0 → 4.3.0 migration end-to-end', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mig42-43-'));
    mkdirSync(join(repo, '.yggdrasil', 'model', 'foo'), { recursive: true });
    writeFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "4.2.0"\nparallel: 1\n');
    writeFileSync(
      join(repo, '.yggdrasil', 'yg-architecture.yaml'),
      'node_types:\n  module:\n    description: "Grouping"\n',
    );
    writeFileSync(
      join(repo, '.yggdrasil', 'model', 'foo', 'yg-node.yaml'),
      'name: foo\ndescription: "test"\ntype: module\nmapping:\n  - src/foo.ts\n',
    );
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'foo.ts'), '');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('runs to-4.3.0, writes version, then validator emits type-without-when-with-mapping', async () => {
    const results = await runMigrations('4.2.0', MIGRATIONS, join(repo, '.yggdrasil'));
    expect(results.length).toBeGreaterThan(0);
    const config = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    expect(config).toMatch(/version: "4\.3\.0"/);

    const graph = await loadGraph(repo);
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-without-when-with-mapping')).toBe(true);
  });

  it('refuse-load triggers when config bumped above 4.3.0', async () => {
    writeFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "4.4.0"\n');
    await expect(loadGraph(repo)).rejects.toThrow(/upgrade CLI/i);
  });
});
