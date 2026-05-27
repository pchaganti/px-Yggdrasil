import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateTo50 } from '../../src/migrations/to-5.0.0.js';
import { runMigrations } from '../../src/core/migrator.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

// ── Helpers ──────────────────────────────────────────────────

function makeV4Repo(root: string, opts: {
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

  it('migrates v4.3 single-provider config to v5 tiers', async () => {
    makeV4Repo(repo, {
      aspects: {
        'requires-logging': 'name: Logging\ndescription: Log on entry\nreviewer: llm\n',
        'no-sync-io': 'name: NoSyncIO\ndescription: No sync calls\nreviewer: ast\n',
      },
    });

    const result = await migrateTo50(join(repo, '.yggdrasil'));

    expect(result.actions.length).toBeGreaterThan(0);

    // Config: v5 tiers structure
    const cfg = parseYaml(readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(cfg.version).toBe('5.0.0');
    const reviewer = cfg.reviewer as Record<string, unknown>;
    expect(reviewer.tiers).toBeDefined();
    const tiers = reviewer.tiers as Record<string, unknown>;
    expect(Object.keys(tiers)).toHaveLength(1);
    const standard = tiers.standard as Record<string, unknown>;
    expect(standard.provider).toBe('ollama');

    // Aspects: reviewer string → object
    const logging = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'requires-logging', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((logging.reviewer as Record<string, unknown>).type).toBe('llm');

    const syncio = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'no-sync-io', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((syncio.reviewer as Record<string, unknown>).type).toBe('ast');
  });

  it('warns and migrates to first provider when multiple providers without active key', async () => {
    makeV4Repo(repo, {
      config: [
        'version: "4.3.0"',
        'reviewer:',
        '  ollama:',
        '    model: qwen3',
        '    endpoint: http://localhost:11434',
        '  anthropic:',
        '    model: claude-3',
      ].join('\n') + '\n',
    });

    const result = await migrateTo50(join(repo, '.yggdrasil'));

    expect(result.warnings.some(w => w.includes('multiple providers'))).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);

    const cfg = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(cfg.version).toBe('5.0.0');
    const reviewer = cfg.reviewer as Record<string, unknown>;
    expect((reviewer.tiers as Record<string, unknown>).standard).toBeDefined();
  });

  it('is idempotent — second run on already-v5 repo produces no actions', async () => {
    makeV4Repo(repo);

    // First migration
    const first = await migrateTo50(join(repo, '.yggdrasil'));
    expect(first.actions.length).toBeGreaterThan(0);

    // Second migration — already v5
    const second = await migrateTo50(join(repo, '.yggdrasil'));
    expect(second.actions.filter(a => !a.includes('version'))).toHaveLength(0);
  });

  it("transforms reviewer: 'ast' string to type: ast", async () => {
    makeV4Repo(repo, {
      aspects: {
        'check-ast': 'name: CheckAST\ndescription: AST check\nreviewer: ast\n',
      },
    });

    await migrateTo50(join(repo, '.yggdrasil'));

    const aspect = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-ast', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    const r = aspect.reviewer as Record<string, unknown>;
    expect(r.type).toBe('ast');
  });

  it("transforms reviewer: 'llm' and reviewer: provider-name strings to type: llm", async () => {
    makeV4Repo(repo, {
      aspects: {
        'check-llm': 'name: CheckLLM\ndescription: LLM check\nreviewer: llm\n',
        'check-named': 'name: CheckNamed\ndescription: Named check\nreviewer: claude-code\n',
      },
    });

    await migrateTo50(join(repo, '.yggdrasil'));

    const llm = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-llm', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((llm.reviewer as Record<string, unknown>).type).toBe('llm');

    const named = parseYaml(
      readFileSync(join(repo, '.yggdrasil', 'aspects', 'check-named', 'yg-aspect.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    expect((named.reviewer as Record<string, unknown>).type).toBe('llm');
  });

  it('migrated repo loads without config errors and passes validation', async () => {
    makeV4Repo(repo, {
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
    // No structural errors (only unapproved drift which is expected)
    const FIXTURE_CODES = new Set(['unapproved', 'source-drift', 'upstream-drift', 'type-without-when-with-mapping', 'schema-missing']);
    const nonDrift = errors.filter(i => !FIXTURE_CODES.has(i.code ?? ''));
    expect(nonDrift).toHaveLength(0);
  });

  it('runMigrations via migrator-runner bumps version to 5.0.0', async () => {
    makeV4Repo(repo);

    const results = await runMigrations('4.3.0', MIGRATIONS, join(repo, '.yggdrasil'));
    expect(results.length).toBeGreaterThan(0);

    const cfg = readFileSync(join(repo, '.yggdrasil', 'yg-config.yaml'), 'utf-8');
    expect(cfg).toMatch(/version: "5\.0\.0"/);
  });
});
