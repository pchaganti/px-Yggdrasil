import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateTo4 } from '../../src/migrations/to-4.0.0.js';
import { runVersionUpgrade } from '../../src/core/migrator-runner.js';

// ── Realistic pre-4.0 (v3.x) → v4.0 content test ──────────────
//
// Reference shape pulled from git tag v3.0.0:
//   - yg-config.yaml carries inline `node_types`, has `name`, and may
//     hold obsolete quality fields (`min_artifact_length`,
//     `context_budget`).
//   - yg-architecture.yaml does NOT exist; node_types live in config.
//   - yg-node.yaml uses object-form aspects (`{ aspect: <id>, ... }`),
//     nested `mapping: { paths: [...] }`, optional `blackbox` flag,
//     and rich relations (`consumes`, `failure`, `event_name`).
//   - Free-form node artifacts: responsibility.md, interface.md,
//     internals.md alongside yg-node.yaml.
//   - Flows ship a `description.md` artifact.
//   - Aspects carry a `stability:` field.
//   - .drift-state contains JSON files from the prior approve runs.

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedV3Repo(opts: { addArtifacts?: boolean; addBlackbox?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-mig-v3-'));
  dirsToCleanup.push(root);
  const ygg = join(root, '.yggdrasil');
  mkdirSync(ygg, { recursive: true });

  // v3 yg-config.yaml — inline node_types, obsolete fields, no parallel
  writeFileSync(
    join(ygg, 'yg-config.yaml'),
    [
      'version: "3.0.0"',
      'name: TheProject',
      'quality:',
      '  min_artifact_length: 50',
      '  context_budget: 8000',
      '  max_direct_relations: 10',
      'node_types:',
      '  library:',
      '    description: "Library module"',
      '  command:',
      '    description: "CLI command"',
      'reviewer:',
      '  active: ollama',
      '  ollama:',
      '    model: qwen3',
      '    endpoint: http://localhost:11434',
    ].join('\n') + '\n',
  );

  // v3 yg-node.yaml — object-form aspects (with exceptions + anchors),
  // nested mapping, blackbox flag, rich relations
  const nodeDir = join(ygg, 'model', 'cli', 'commands', 'aspects');
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, 'yg-node.yaml'),
    [
      'name: AspectsCommand',
      'type: library',
      'description: "Lists all aspects"',
      ...(opts.addBlackbox ? ['blackbox: true'] : []),
      'aspects:',
      '  - aspect: deterministic',
      '  - aspect: cli-command-contract',
      '    exceptions: ["legacy-edge-case"]',
      '    anchors: ["primary"]',
      'relations:',
      '  - target: cli/core/loader',
      '    type: uses',
      '    consumes: [loadGraph]',
      '    failure: throw',
      '    event_name: graph-loaded',
      'mapping:',
      '  paths:',
      '    - source/cli/src/cli/aspects.ts',
    ].join('\n') + '\n',
  );

  if (opts.addArtifacts !== false) {
    writeFileSync(join(nodeDir, 'responsibility.md'), 'Old responsibility doc\n');
    writeFileSync(join(nodeDir, 'interface.md'), 'Old interface doc\n');
    writeFileSync(join(nodeDir, 'internals.md'), 'Old internals doc\n');
  }

  // v3 flow with description.md artifact
  const flowDir = join(ygg, 'flows', 'drift');
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, 'yg-flow.yaml'),
    [
      'name: "Drift detection"',
      'description: "Detect divergence"',
      'nodes:',
      '  - cli/commands/aspects',
    ].join('\n') + '\n',
  );
  writeFileSync(join(flowDir, 'description.md'), 'Old flow artifact\n');

  // v3 aspect with stability field
  const aspectDir = join(ygg, 'aspects', 'deterministic');
  mkdirSync(aspectDir, { recursive: true });
  writeFileSync(
    join(aspectDir, 'yg-aspect.yaml'),
    [
      'name: Deterministic',
      'description: "Deterministic outputs"',
      'stability: stable',
    ].join('\n') + '\n',
  );
  writeFileSync(join(aspectDir, 'content.md'), 'Aspect content.\n');

  // v3 drift state
  const driftDir = join(ygg, '.drift-state', 'cli', 'commands', 'aspects');
  mkdirSync(driftDir, { recursive: true });
  writeFileSync(join(driftDir, 'baseline.json'), '{"hash":"old"}');

  return ygg;
}

function readYaml(filePath: string): Record<string, unknown> {
  return parseYaml(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

describe('to-4.0.0 — realistic v3 → v4.0 content transformation', () => {
  let ygg: string;
  beforeEach(() => { ygg = seedV3Repo(); });

  it('extracts inline node_types into yg-architecture.yaml', async () => {
    expect(existsSync(join(ygg, 'yg-architecture.yaml'))).toBe(false);

    await migrateTo4(ygg);

    expect(existsSync(join(ygg, 'yg-architecture.yaml'))).toBe(true);
    const arch = readYaml(join(ygg, 'yg-architecture.yaml'));
    const nodeTypes = arch.node_types as Record<string, Record<string, unknown>>;
    expect(Object.keys(nodeTypes).sort()).toEqual(['command', 'library']);
    expect(nodeTypes.library.description).toContain('Library');
  });

  it('strips name, node_types, and obsolete quality fields from yg-config.yaml; adds parallel: 1', async () => {
    // The migration no longer writes the version itself — the runner is the
    // sole writer. Drive it through the runner so the version still advances.
    await runVersionUpgrade({
      yggRoot: ygg,
      migrations: [{ to: '4.0.0', description: 'to 4.0.0', run: migrateTo4 }],
    });

    const cfg = readYaml(join(ygg, 'yg-config.yaml'));
    expect(cfg).not.toHaveProperty('name');
    expect(cfg).not.toHaveProperty('node_types');
    const quality = cfg.quality as Record<string, unknown> | undefined;
    expect(quality).not.toHaveProperty('min_artifact_length');
    expect(quality).not.toHaveProperty('context_budget');
    expect(quality?.max_direct_relations).toBe(10);
    expect(cfg.parallel).toBe(1);
    expect(cfg.version).toBe('4.0.0');
  });

  it('flattens object-form aspects into bare string ids and warns on dropped exceptions/anchors', async () => {
    const result = await migrateTo4(ygg);

    const node = readYaml(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'));
    expect(node.aspects).toEqual(['deterministic', 'cli-command-contract']);
    expect(result.warnings.some((w) => w.includes('exceptions') && w.includes('cli-command-contract'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('anchors') && w.includes('cli-command-contract'))).toBe(true);
  });

  it('flattens nested mapping.paths into a flat array under mapping', async () => {
    await migrateTo4(ygg);

    const node = readYaml(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'));
    expect(Array.isArray(node.mapping)).toBe(true);
    expect(node.mapping).toEqual(['source/cli/src/cli/aspects.ts']);
  });

  it('strips consumes, failure, and event_name from relations', async () => {
    await migrateTo4(ygg);

    const node = readYaml(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'));
    const relations = node.relations as Array<Record<string, unknown>>;
    expect(relations).toHaveLength(1);
    expect(relations[0]).toEqual({ target: 'cli/core/loader', type: 'uses' });
    expect(relations[0]).not.toHaveProperty('consumes');
    expect(relations[0]).not.toHaveProperty('failure');
    expect(relations[0]).not.toHaveProperty('event_name');
  });

  it('removes blackbox flag from node yaml', async () => {
    rmSync(ygg, { recursive: true, force: true });
    ygg = seedV3Repo({ addBlackbox: true });

    await migrateTo4(ygg);

    const node = readYaml(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'));
    expect(node).not.toHaveProperty('blackbox');
  });

  it('deletes responsibility.md, interface.md, internals.md from node directories', async () => {
    const nodeDir = join(ygg, 'model', 'cli', 'commands', 'aspects');
    expect(existsSync(join(nodeDir, 'responsibility.md'))).toBe(true);
    expect(existsSync(join(nodeDir, 'interface.md'))).toBe(true);
    expect(existsSync(join(nodeDir, 'internals.md'))).toBe(true);

    await migrateTo4(ygg);

    expect(existsSync(join(nodeDir, 'responsibility.md'))).toBe(false);
    expect(existsSync(join(nodeDir, 'interface.md'))).toBe(false);
    expect(existsSync(join(nodeDir, 'internals.md'))).toBe(false);
    // yg-node.yaml stays
    expect(existsSync(join(nodeDir, 'yg-node.yaml'))).toBe(true);
  });

  it('deletes flow description.md artifact and leaves yg-flow.yaml intact', async () => {
    const flowDir = join(ygg, 'flows', 'drift');
    expect(existsSync(join(flowDir, 'description.md'))).toBe(true);

    await migrateTo4(ygg);

    expect(existsSync(join(flowDir, 'description.md'))).toBe(false);
    expect(existsSync(join(flowDir, 'yg-flow.yaml'))).toBe(true);
  });

  it('removes stability field from aspect yaml; content.md untouched', async () => {
    const aspectDir = join(ygg, 'aspects', 'deterministic');

    await migrateTo4(ygg);

    const aspect = readYaml(join(aspectDir, 'yg-aspect.yaml'));
    expect(aspect).not.toHaveProperty('stability');
    expect(aspect.name).toBe('Deterministic');
    expect(existsSync(join(aspectDir, 'content.md'))).toBe(true);
  });

  it('deletes all .json files from .drift-state recursively', async () => {
    const driftFile = join(ygg, '.drift-state', 'cli', 'commands', 'aspects', 'baseline.json');
    expect(existsSync(driftFile)).toBe(true);

    await migrateTo4(ygg);

    expect(existsSync(driftFile)).toBe(false);
  });

  it('reports each transformation in actions; warnings only for dropped data', async () => {
    const result = await migrateTo4(ygg);

    expect(result.actions.some((a) => a.includes('Extracted node_types'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Cleaned config'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Rewrote node'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Deleted node artifact'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Deleted flow artifact'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Removed stability from aspect'))).toBe(true);
    expect(result.actions.some((a) => a.includes('Deleted drift state'))).toBe(true);
    expect(result.actions.some((a) => a.includes('the runner will bump yg-config.yaml version to 4.0.0'))).toBe(true);
  });

  it('is idempotent — running migrateTo4 twice produces the same final state', async () => {
    await migrateTo4(ygg);
    const arch1 = readFileSync(join(ygg, 'yg-architecture.yaml'), 'utf-8');
    const config1 = readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8');
    const node1 = readFileSync(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'), 'utf-8');

    const result2 = await migrateTo4(ygg);

    expect(readFileSync(join(ygg, 'yg-architecture.yaml'), 'utf-8')).toBe(arch1);
    expect(readFileSync(join(ygg, 'yg-config.yaml'), 'utf-8')).toBe(config1);
    expect(readFileSync(join(ygg, 'model', 'cli', 'commands', 'aspects', 'yg-node.yaml'), 'utf-8')).toBe(node1);
    // No artifact-related actions on second run — everything already cleaned
    expect(result2.actions.some((a) => a.includes('Rewrote node'))).toBe(false);
    expect(result2.actions.some((a) => a.includes('Deleted node artifact'))).toBe(false);
  });
});
