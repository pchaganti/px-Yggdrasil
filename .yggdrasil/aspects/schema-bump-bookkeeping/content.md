# Schema Bump Bookkeeping

When a migration applies changes to the graph, it must record completion by calling `updateConfigVersion(yggRoot, targetVersion)`. If the migration detects that no changes are needed and returns early, it must NOT call `updateConfigVersion()`.

## Rules

- A migration that performs at least one write operation must call `updateConfigVersion(yggRoot, 'X.Y.Z')` after completing all writes, where `'X.Y.Z'` is the migration's target version.
- A migration that detects no changes are needed and returns early — before any write — must NOT call `updateConfigVersion()`. The migrator uses the recorded version to detect which migrations have been applied; calling it on a no-op run would mark the migration complete and skip it on future runs even though no changes were made.
- The `MigrationResult.actions` array must include a description of the version update (e.g. `Updated yg-config.yaml: version X → Y`) when `updateConfigVersion()` is called.
- If `updateConfigVersion()` fails (e.g. `yg-config.yaml` is missing), the failure must be captured as a `warnings` entry in the returned `MigrationResult`, not re-thrown as an error.

## Rationale

The migrator sequences migrations by comparing each migration's target version against the current version in `yg-config.yaml`. If a migration exits without calling `updateConfigVersion()`, `yg init --upgrade` will attempt the same migration again — which is safe due to the `migration-idempotent` contract, but wastes work. If a migration calls `updateConfigVersion()` when no writes were actually done, the `actions` log will be empty and the user receives a misleading summary suggesting changes were made.
