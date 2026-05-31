import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVersionUpgrade } from '../../src/core/migrator-runner.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

const MIGRATION_TO_4_3 = MIGRATIONS.filter((m) => m.to === '4.3.0');
const ALL_MIGRATIONS = MIGRATIONS;

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

  it('advances the version exactly one step to 4.3.0 and the validator emits type-without-when-with-mapping', async () => {
    expect(MIGRATION_TO_4_3).toHaveLength(1);
    const upgrade = await runVersionUpgrade({
      yggRoot: join(repo, '.yggdrasil'),
      migrations: MIGRATION_TO_4_3,
    });
    expect(upgrade.migrationActions.length).toBeGreaterThan(0);
    const config = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    expect(config).toMatch(/version:\s*["']4\.3\.0["']/);
    expect(config).not.toMatch(/version:\s*["']5\.0\.0["']/);

    // Run the remaining migrations to reach 5.0.0 so loadGraph can succeed
    // (the lower-bound version gate refuses to load graphs older than the CLI).
    // The validator check for 'type-without-when-with-mapping' is a structural
    // check that still fires on 5.0.0 graphs with types that have mappings but no when.
    await runVersionUpgrade({
      yggRoot: join(repo, '.yggdrasil'),
      migrations: ALL_MIGRATIONS.filter((m) => m.to !== '4.3.0'),
    });

    const graph = await loadGraph(repo);
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-without-when-with-mapping')).toBe(true);
  });

  it('refuse-load triggers when config bumped above 5.0.0', async () => {
    writeFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'version: "6.0.0"\n');
    // A too-new schema version is an expected user error (upgrade the CLI), thrown as
    // UnsupportedSchemaVersionError; the "upgrade CLI" guidance now lives in the
    // command-layer presentation, not the loader's message.
    await expect(loadGraph(repo)).rejects.toThrow(/newer than this CLI supports/i);
  });
});
