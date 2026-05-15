import { runMigrations, updateConfigVersion } from './migrator.js';
import type { Migration } from './migrator.js';

export interface RunUpgradeOptions {
  yggRoot: string;
  fromVersion: string;
  toVersion: string;
  migrations: Migration[];
}

export interface UpgradeResult {
  migrationActions: string[];
  migrationWarnings: string[];
}

export async function runVersionUpgrade(options: RunUpgradeOptions): Promise<UpgradeResult> {
  const { yggRoot, fromVersion, toVersion, migrations } = options;
  const migrationResults = await runMigrations(fromVersion, migrations, yggRoot);
  await updateConfigVersion(yggRoot, toVersion);
  const migrationActions: string[] = [];
  const migrationWarnings: string[] = [];
  for (const r of migrationResults) {
    migrationActions.push(...r.actions);
    migrationWarnings.push(...r.warnings);
  }
  return { migrationActions, migrationWarnings };
}
