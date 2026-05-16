import type { MigrationResult } from '../core/migrator.js';
import { detectVersion, updateConfigVersion } from '../core/migrator.js';

export async function migrateTo44(yggRoot: string): Promise<MigrationResult> {
  const current = await detectVersion(yggRoot);
  if (current === null) {
    throw new Error(
      `migration to 4.4.0: yg-config.yaml missing or has no \`version\` field. ` +
        `Run \`yg init --upgrade\` to populate it first.`,
    );
  }

  if (current === '4.4.0') {
    return { actions: ['yg-config.yaml already at 4.4.0 — no changes needed'], warnings: [] };
  }

  const actions: string[] = [];
  const warnings: string[] = [];

  try {
    await updateConfigVersion(yggRoot, '4.4.0');
    actions.push(`Updated yg-config.yaml: version ${current} → 4.4.0`);
  } catch (err) {
    warnings.push(`Failed to update yg-config.yaml version: ${(err as Error).message}`);
    return { actions, warnings };
  }

  warnings.push(
    `Migrated to schema 4.4.0. New validation rules in effect:
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
