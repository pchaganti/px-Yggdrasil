import { gt, valid, compare } from 'semver';
import { detectVersion, updateConfigVersion } from './migrator.js';
import type { Migration } from './migrator.js';

export interface RunUpgradeOptions {
  yggRoot: string;
  migrations: Migration[];
  /**
   * The schema version this CLI supports — used to lift the config version
   * when no migrations apply but the project is below the supported schema.
   * Defaults to '5.0.0' if omitted.
   */
  targetVersion?: string;
}

export interface UpgradeResult {
  fromVersion: string | null;
  landedVersion: string | null;
  migrationActions: string[];
  migrationWarnings: string[];
  /**
   * True when a migration returned `bumpVersion: false`, stopping the chain
   * before it reached the latest applicable target — i.e. the upgrade is
   * INCOMPLETE and the version was withheld. Distinct from a completed upgrade
   * that merely emitted informational warnings (withheld === false).
   */
  withheld: boolean;
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
  const resolvedTarget = options.targetVersion ?? '5.0.0';
  const fromVersion = await detectVersion(yggRoot);

  const migrationActions: string[] = [];
  const migrationWarnings: string[] = [];

  if (fromVersion === null || valid(fromVersion) === null) {
    return { fromVersion, landedVersion: fromVersion, migrationActions, migrationWarnings, withheld: false };
  }

  const applicable = migrations
    .filter((m) => {
      const mVer = valid(m.to);
      return mVer !== null && gt(mVer, fromVersion);
    })
    .sort((a, b) => compare(valid(a.to)!, valid(b.to)!));

  let landedVersion = fromVersion;
  let withheld = false;

  for (const migration of applicable) {
    const result = await migration.run(yggRoot);
    migrationActions.push(...result.actions);
    migrationWarnings.push(...result.warnings);

    if (result.bumpVersion === false) {
      // Migration emitted warnings — version stays where it was; do not
      // advance to migration.to. The user fixes the listed problems and
      // re-runs. Stop the chain (later migrations may depend on this step
      // having completed). This is a WITHHELD (incomplete) upgrade.
      withheld = true;
      break;
    }

    // Advance version to this migration's target. The runner is the SOLE
    // writer of yg-config.yaml's version field — migrations never write it
    // themselves; they only withhold the bump via bumpVersion: false.
    try {
      await updateConfigVersion(yggRoot, migration.to);
      landedVersion = migration.to;
    } catch {
      // yg-config.yaml absent — the migration itself reported this via a
      // warning, so skip silently here to avoid a duplicate entry.
    }
  }

  // When the migration chain ran to completion (or was empty) but the
  // project version is still below the supported schema — no automated
  // transformations exist for this gap — lift the config version directly
  // to the supported schema so yg check does not keep reporting an
  // outdated version error.
  if (!withheld && valid(resolvedTarget) && gt(resolvedTarget, landedVersion)) {
    try {
      await updateConfigVersion(yggRoot, resolvedTarget);
      migrationActions.push(
        `version updated to ${resolvedTarget} — no automatic transformations exist; ` +
        `yg check will flag any stale config fields with exact errors`,
      );
      landedVersion = resolvedTarget;
    } catch {
      // yg-config.yaml absent — nothing to update.
    }
  }

  return { fromVersion, landedVersion, migrationActions, migrationWarnings, withheld };
}
