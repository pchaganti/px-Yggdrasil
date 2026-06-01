import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MigrationResult } from '../core/migrator.js';

/**
 * Migration 4.3.0: introduce `log_required` field on architecture node types.
 *
 * Default for the new field is `true` in code. For existing repos we
 * explicitly write `log_required: false` per node_type to preserve current
 * behaviour. Engineer can flip to `true` per type when ready.
 *
 * Skips types that already have `log_required` declared.
 */
export async function migrateTo43(yggRoot: string): Promise<MigrationResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const archPath = path.join(yggRoot, 'yg-architecture.yaml');

  let raw: string;
  try {
    raw = await readFile(archPath, 'utf-8');
  } catch {
    warnings.push('yg-architecture.yaml not found — skipping log_required migration');
    return { actions, warnings };
  }

  const parsed = parseYaml(raw) as Record<string, unknown>;
  const nodeTypes = parsed?.node_types as Record<string, Record<string, unknown>> | undefined;
  if (!nodeTypes || typeof nodeTypes !== 'object') {
    warnings.push('yg-architecture.yaml missing node_types — skipping');
    return { actions, warnings };
  }

  const touched: string[] = [];
  for (const [typeName, entry] of Object.entries(nodeTypes)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (Object.prototype.hasOwnProperty.call(entry, 'log_required')) continue;
    entry.log_required = false;
    touched.push(typeName);
  }

  if (touched.length === 0) {
    actions.push('All node_types already declare log_required — no changes needed');
    return { actions, warnings };
  }

  await writeFile(archPath, stringifyYaml(parsed, { lineWidth: 0 }), 'utf-8');
  actions.push(`Set log_required: false explicitly on ${touched.length} node_type(s): ${touched.join(', ')}`);
  actions.push('Migration complete; the runner will bump yg-config.yaml version to 4.3.0.');
  warnings.push(
    `Migrated to schema 4.3.0. New validation rules in effect:
  - Types with \`when\` predicate classify files (forward + optional strict backward).
  - Types without \`when\` are organizational (parent-only, nodes cannot have mapping).
  - Mappings cannot contain \`.gitignored\` files.
  - Existing \`unmapped-files\` error continues to enforce full repo coverage.

Existing types without \`when\` are valid (organizational), BUT any node of
such type that currently has \`mapping:\` will fire \`type-without-when-with-mapping\`.

See: yg knowledge read working-with-architecture`,
  );
  return { actions, warnings };
}
