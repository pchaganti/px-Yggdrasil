import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateTo50 } from '../../src/migrations/to-5.0.0.js';
import { runMigrations } from '../../src/core/migrator.js';
import { runVersionUpgrade } from '../../src/core/migrator-runner.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

// ── Helpers ──────────────────────────────────────────────────

function makeLegacyRepo(root: string, opts: {
  config?: string;
  aspects?: Record<string, string>;
} = {}) {
  const yggRoot = join(root, '.yggdrasil');
  mkdirSync(join(yggRoot, 'model', 'foo'), { recursive: true });
  mkdirSync(join(yggRoot, 'schemas'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });

  const config = opts.config ?? [
    'version: "4.3.0"',
    'reviewer:',
    '  active: ollama',
    '  consensus: 1',
    '  ollama:',
    '    model: qwen3',
    '    endpoint: http://localhost:11434',
  ].join('\n') + '\n';

  writeFileSync(join(yggRoot, 'yg-config.yaml'), config);
  writeFileSync(
    join(yggRoot, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: "Service"\n',
  );
  writeFileSync(
    join(yggRoot, 'model', 'foo', 'yg-node.yaml'),
    'name: foo\ndescription: "test"\ntype: service\nmapping:\n  - src/foo.ts\n',
  );
  writeFileSync(join(root, 'src', 'foo.ts'), 'export const x = 1;\n');

  if (opts.aspects) {
    for (const [id, yaml] of Object.entries(opts.aspects)) {
      mkdirSync(join(yggRoot, 'aspects', id), { recursive: true });
      writeFileSync(join(yggRoot, 'aspects', id, 'yg-aspect.yaml'), yaml);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('migration 4.3 → 5.0', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mig43-50-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('migrates single-provider legacy config to tier named after the provider', async () => {
    makeLegacyRepo(repo, {
      aspects: {
        'requires-logging': 'name: Logging\ndescription: Log on entry\nreviewer: llm\n',
        'no-sync-io': 'name: NoSyncIO\ndescription: No sync calls\nreviewer: ast\n',
      },
    });

    const result = await migrateTo50(join(repo, '.yggdrasil'));
    expect(result.bumpVersion).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);

    const cfg = parseYaml(readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8')) as Record<string, unknown>;
    const reviewer = cfg.reviewer as Record<string, unknown>;
    const tiers = reviewer.tiers as Record<string, unknown>;
    expect(Object.keys(tiers)).toEqual(['ollama']);
    const ollama = tiers.ollama as Record<string, unknown>;
    expect(ollama.provider).toBe('ollama');
    // Default omitted for single-tier configs
    expect(reviewer.default).toBeUndefined();

    const logging = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((logging.reviewer as Record<string, unknown>).type).toBe('llm');

    const syncio = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'no-sync-io', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((syncio.reviewer as Record<string, unknown>).type).toBe('ast');
  });

  it('preserves multiple providers as named tiers when active is set', async () => {
    makeLegacyRepo(repo, {
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  active: anthropic',
        '  consensus: 1',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '  anthropic:',
        '    model: claude-3',
        '    temperature: 0',
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(join(repo, '.yggdrasil'));
    expect(result.bumpVersion).toBe(true);

    const cfg = parseYaml(readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8')) as Record<string, unknown>;
    const reviewer = cfg.reviewer as Record<string, unknown>;
    expect(reviewer.default).toBe('anthropic');
    const tiers = reviewer.tiers as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers).sort()).toEqual(['anthropic', 'ollama']);
    expect(tiers.anthropic.provider).toBe('anthropic');
    expect(tiers.ollama.provider).toBe('ollama');
    expect((tiers.ollama.config as Record<string, unknown>).endpoint).toBe('http://localhost:11434');
  });

  it('STOPS when multiple providers without active — no rewrite, no version bump', async () => {
    makeLegacyRepo(repo, {
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '  anthropic:',
        '    model: claude-3',
      ].join('\n') + '\n',
      aspects: { 'one': 'name: One\nreviewer: llm\n' },
    });

    const before = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    const aspectBefore = readFileSync(join(repo, '.yggdrasil', 'aspects', 'one', 'yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(join(repo, '.yggdrasil'));
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('multiple providers'))).toBe(true);

    expect(readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8')).toBe(before);
    expect(readFileSync(join(repo, '.yggdrasil', 'aspects', 'one', 'yg-aspect.yaml'), 'utf-8')).toBe(aspectBefore);
  });

  it('is idempotent — second run on already-migrated repo produces no further actions', async () => {
    makeLegacyRepo(repo);
    const first = await migrateTo50(join(repo, '.yggdrasil'));
    expect(first.actions.length).toBeGreaterThan(0);

    const second = await migrateTo50(join(repo, '.yggdrasil'));
    expect(second.actions.filter(a => a.includes('tier-based shape'))).toHaveLength(0);
    expect(second.bumpVersion).toBe(true);
  });

  it("transforms reviewer: 'ast' string to type: ast", async () => {
    makeLegacyRepo(repo, {
      aspects: { 'check-ast': 'name: CheckAST\ndescription: AST check\nreviewer: ast\n' },
    });

    await migrateTo50(join(repo, '.yggdrasil'));
    const aspect = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-ast', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((aspect.reviewer as Record<string, unknown>).type).toBe('ast');
  });

  it("WARNS for reviewer: 'claude-code' (unrecognized) — file unchanged", async () => {
    makeLegacyRepo(repo, {
      aspects: {
        'check-named': 'name: CheckNamed\ndescription: Named check\nreviewer: claude-code\n',
      },
    });
    const before = readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-named', 'yg-aspect.yaml'), 'utf-8');

    const result = await migrateTo50(join(repo, '.yggdrasil'));
    expect(result.bumpVersion).toBe(false);
    expect(result.warnings.some(w => w.includes('unrecognized reviewer value'))).toBe(true);
    expect(readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-named', 'yg-aspect.yaml'), 'utf-8')).toBe(before);
  });

  it('migrated repo loads without config errors and passes validation', async () => {
    makeLegacyRepo(repo, {
      aspects: {
        'requires-logging': 'name: Logging\ndescription: Log on entry\nreviewer: llm\n',
      },
    });
    mkdirSync(join(repo, '.yggdrasil', 'aspects', 'requires-logging'), { recursive: true });
    writeFileSync(
      join(repo, '.yggdrasil', 'aspects', 'requires-logging', 'content.md'),
      'Log on entry.\n',
    );

    await migrateTo50(join(repo, '.yggdrasil'));

    const graph = await loadGraph(repo);
    expect(graph.configError).toBeUndefined();

    const validation = await validate(graph);
    const errors = validation.issues.filter(i => i.severity === 'error');
    const FIXTURE_CODES = new Set(['unapproved', 'source-drift', 'upstream-drift', 'type-without-when-with-mapping', 'schema-missing']);
    const nonDrift = errors.filter(i => !FIXTURE_CODES.has(i.code ?? ''));
    expect(nonDrift).toHaveLength(0);
  });

  it('runVersionUpgrade advances version exactly one step to 5.0.0 on success', async () => {
    makeLegacyRepo(repo);

    const { migrationActions, migrationWarnings } = await runVersionUpgrade({
      yggRoot: join(repo, '.yggdrasil'),
      migrations: MIGRATIONS,
    });

    expect(migrationWarnings).toEqual([]);
    expect(migrationActions.length).toBeGreaterThan(0);
    const cfg = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    expect(cfg).toMatch(/version:\s*["']5\.0\.0["']/);
  });

  it('runVersionUpgrade does NOT bump version when warnings present', async () => {
    makeLegacyRepo(repo, {
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '  anthropic:',
        '    model: claude-3',
      ].join('\n') + '\n',
    });

    const before = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    const { migrationWarnings } = await runVersionUpgrade({
      yggRoot: join(repo, '.yggdrasil'),
      migrations: MIGRATIONS,
    });
    expect(migrationWarnings.length).toBeGreaterThan(0);
    expect(readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8')).toBe(before);
  });

  it('runMigrations applies the registered migration', async () => {
    makeLegacyRepo(repo);
    const results = await runMigrations('4.3.0', MIGRATIONS, join(repo, '.yggdrasil'));
    expect(results.length).toBeGreaterThan(0);
  });
});
