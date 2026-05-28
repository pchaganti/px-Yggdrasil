import { gt, valid, compare } from 'semver';
import { detectVersion, updateConfigVersion } from './migrator.js';
import type { Migration } from './migrator.js';

export interface RunUpgradeOptions {
  yggRoot: string;
  migrations: Migration[];
}

export interface UpgradeResult {
  fromVersion: string | null;
  landedVersion: string | null;
  migrationActions: string[];
  migrationWarnings: string[];
}

/**
 * Run every applicable migration in order, advancing the project version one
 * step per migration. The contract is incremental: with registered migrations
 * targeting (4.0.0, 4.3.0, 5.0.0) and a project at 4.0.0, the version moves
 * 4.0.0 → 4.3.0 → 5.0.0; each intermediate value is persisted to
 * yg-config.yaml before the next migration runs.
 *
 * The current version is read from yg-config.yaml via detectVersion — no
 * fromVersion parameter. If a migration returns `bumpVersion: false`, the
 * chain stops. The version stays at the last successfully completed
 * migration's target (or the original version if no migration completed).
 * The user fixes the listed warnings and re-runs.
 */
export async function runVersionUpgrade(options: RunUpgradeOptions): Promise<UpgradeResult> {
  const { yggRoot, migrations } = options;
  const fromVersion = await detectVersion(yggRoot);

  const migrationActions: string[] = [];
  const migrationWarnings: string[] = [];

  if (fromVersion === null || valid(fromVersion) === null) {
    return { fromVersion, landedVersion: fromVersion, migrationActions, migrationWarnings };
  }

  const applicable = migrations
    .filter((m) => {
      const mVer = valid(m.to);
      return mVer !== null && gt(mVer, fromVersion);
    })
    .sort((a, b) => compare(valid(a.to)!, valid(b.to)!));

  let landedVersion = fromVersion;

  for (const migration of applicable) {
    const result = await migration.run(yggRoot);
    migrationActions.push(...result.actions);
    migrationWarnings.push(...result.warnings);

    if (result.bumpVersion === false) {
      // Migration emitted warnings — version stays where it was; do not
      // advance to migration.to. The user fixes the listed problems and
      // re-runs. Stop the chain (later migrations may depend on this step
      // having completed).
      break;
    }

    // Advance version to this migration's target. Pattern A migrations
    // may have already written this same value internally — the second
    // write is a no-op-equivalent (writes the same string).
    try {
      await updateConfigVersion(yggRoot, migration.to);
      landedVersion = migration.to;
    } catch {
      // yg-config.yaml absent — the migration itself reported this via a
      // warning, so skip silently here to avoid a duplicate entry.
    }
  }

  return { fromVersion, landedVersion, migrationActions, migrationWarnings };
}
