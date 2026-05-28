import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateTo43 } from '../../src/migrations/to-4.3.0.js';

// ── Realistic v4.0/v4.2 → v4.3 content test ───────────────────
//
// Reference shape pulled from git tag v4.2.0:
//   - yg-architecture.yaml carries `node_types` as a mapping; entries
//     do NOT declare `log_required` (the field is introduced in 4.3).
//   - Entries may optionally declare `aspects` per type and a parent
//     hierarchy via `parents:`.
//   - No `when:` predicates yet (also a 4.3 addition; types are still
//     classified informally by `type:` on yg-node.yaml).

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedV42Repo(architectureYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-mig-v42-'));
  dirsToCleanup.push(root);
  const ygg = join(root, '.yggdrasil');
  mkdirSync(ygg, { recursive: true });
  writeFileSync(join(ygg, 'yg-config.yaml'), 'version: "4.2.0"\nparallel: 1\n');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), architectureYaml);
  return ygg;
}

function readYaml(filePath: string): Record<string, unknown> {
  return parseYaml(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

describe('to-4.3.0 — realistic v4.x → v4.3 architecture transformation', () => {
  it('adds log_required: false to every node_type that lacks the field', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Grouping node"',
      '  command:',
      '    description: "CLI command handler"',
      '    aspects: [cli-command-contract]',
      '  engine:',
      '    description: "Core domain logic"',
      '    aspects: [deterministic]',
      '  adapter:',
      '    description: "I/O boundary"',
      '  types:',
      '    description: "Pure type definitions"',
      '  test:',
      '    description: "Test suite"',
      '  project:',
      '    description: "Top-level infrastructure"',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const nodeTypes = arch.node_types as Record<string, Record<string, unknown>>;
    for (const [name, entry] of Object.entries(nodeTypes)) {
      expect(entry.log_required, `node_type ${name} must have log_required`).toBe(false);
    }
    // Existing fields preserved (description, aspects).
    expect(nodeTypes.command.aspects).toEqual(['cli-command-contract']);
    expect(nodeTypes.engine.description).toContain('Core domain logic');

    // Action enumerates the seven touched types.
    const action = result.actions.find((a) => a.includes('log_required: false explicitly'));
    expect(action).toBeDefined();
    expect(action).toMatch(/7 node_type/);
    for (const name of ['module', 'command', 'engine', 'adapter', 'types', 'test', 'project']) {
      expect(action).toContain(name);
    }
    expect(result.actions.some((a) => a.includes('version → 4.3.0'))).toBe(true);
  });

  it('leaves node_types that already declare log_required untouched', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Grouping"',
      '    log_required: true',
      '  command:',
      '    description: "Command"',
      '    log_required: false',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const nodeTypes = arch.node_types as Record<string, Record<string, unknown>>;
    expect(nodeTypes.module.log_required).toBe(true);
    expect(nodeTypes.command.log_required).toBe(false);
    expect(result.actions.some((a) => a.includes('All node_types already declare log_required'))).toBe(true);
    expect(result.actions.some((a) => a.includes('version → 4.3.0'))).toBe(false);
  });

  it('partial coverage — only touches types missing the field', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Has it"',
      '    log_required: true',
      '  command:',
      '    description: "Missing"',
      '  engine:',
      '    description: "Missing too"',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const nodeTypes = arch.node_types as Record<string, Record<string, unknown>>;
    expect(nodeTypes.module.log_required).toBe(true);
    expect(nodeTypes.command.log_required).toBe(false);
    expect(nodeTypes.engine.log_required).toBe(false);
    const action = result.actions.find((a) => a.includes('log_required: false explicitly'));
    expect(action).toMatch(/2 node_type/);
    expect(action).toContain('command');
    expect(action).toContain('engine');
    expect(action).not.toMatch(/module/);
  });

  it('preserves all other node_type fields (parents, aspects, mapping_pattern, etc.) verbatim', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  service:',
      '    description: "Backend service"',
      '    aspects:',
      '      - deterministic',
      '      - audit-logging',
      '    parents: [module]',
      '    mapping_pattern: "src/services/**"',
      '    relations:',
      '      uses: [adapter, engine]',
    ].join('\n') + '\n');

    await migrateTo43(ygg);

    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const service = (arch.node_types as Record<string, Record<string, unknown>>).service;
    expect(service.log_required).toBe(false);
    expect(service.description).toBe('Backend service');
    expect(service.aspects).toEqual(['deterministic', 'audit-logging']);
    expect(service.parents).toEqual(['module']);
    expect(service.mapping_pattern).toBe('src/services/**');
    expect(service.relations).toEqual({ uses: ['adapter', 'engine'] });
  });

  it('skips entries that are not object mappings (defensive)', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  good:',
      '    description: "Has it"',
      '  bad: "scalar value"',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const nodeTypes = arch.node_types as Record<string, unknown>;
    // Object entry gets the field.
    expect((nodeTypes.good as Record<string, unknown>).log_required).toBe(false);
    // Scalar entry remains a scalar (validator will reject it as malformed).
    expect(nodeTypes.bad).toBe('scalar value');
    const action = result.actions.find((a) => a.includes('log_required: false explicitly'));
    expect(action).toMatch(/1 node_type/);
    expect(action).toContain('good');
    expect(action).not.toContain('bad');
  });

  it('warns and skips when yg-architecture.yaml is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yg-mig-v42-noarch-'));
    dirsToCleanup.push(root);
    const ygg = join(root, '.yggdrasil');
    mkdirSync(ygg, { recursive: true });
    writeFileSync(join(ygg, 'yg-config.yaml'), 'version: "4.2.0"\n');

    const result = await migrateTo43(ygg);

    expect(result.warnings.some((w) => w.includes('yg-architecture.yaml not found'))).toBe(true);
    expect(result.actions.some((a) => a.includes('version → 4.3.0'))).toBe(false);
  });

  it('warns when yg-architecture.yaml has no node_types key', async () => {
    const ygg = seedV42Repo('# empty file\n');

    const result = await migrateTo43(ygg);

    expect(result.warnings.some((w) => w.includes('node_types'))).toBe(true);
    expect(result.actions.some((a) => a.includes('version → 4.3.0'))).toBe(false);
  });

  it('is idempotent — re-running on already-4.3 architecture produces no changes', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Group"',
    ].join('\n') + '\n');

    await migrateTo43(ygg);
    const after1 = readFileSync(join(ygg, 'yg-architecture.yaml'), 'utf-8');

    const result2 = await migrateTo43(ygg);

    expect(readFileSync(join(ygg, 'yg-architecture.yaml'), 'utf-8')).toBe(after1);
    expect(result2.actions.some((a) => a.includes('log_required: false explicitly'))).toBe(false);
    expect(result2.actions.some((a) => a.includes('All node_types already declare log_required'))).toBe(true);
  });

  it('emits the 4.3 migration advisory that flags type-without-when-with-mapping as a new validation rule', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Group"',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    const advisory = result.warnings.find((w) => w.includes('Migrated to schema 4.3.0'));
    expect(advisory).toBeDefined();
    expect(advisory).toContain('type-without-when-with-mapping');
    expect(advisory).toContain('organizational');
  });

  it('writes version 4.3.0 only after touching the architecture, never on the no-op path', async () => {
    const ygg = seedV42Repo([
      'node_types:',
      '  module:',
      '    description: "Group"',
      '    log_required: false',
    ].join('\n') + '\n');

    const result = await migrateTo43(ygg);

    // log_required already set on every type → no architecture write → no version bump
    // from this migration alone. (The runner may bump from another step.)
    const cfg = readYaml(join(ygg, 'yg-config.yaml'));
    expect(cfg.version).toBe('4.2.0');
    expect(result.actions.some((a) => a.includes('version → 4.3.0'))).toBe(false);
  });
});
