# Schema Bump Bookkeeping

A migration is responsible for completion bookkeeping. There are two acceptable patterns; every migration must use exactly one of them, consistently.

## Rules

A migration that applies changes to the graph MUST use one of the following two patterns to mark its completion:

### Pattern A — migration writes the version itself

- After completing all writes, call `updateConfigVersion(yggRoot, 'X.Y.Z')`, where `'X.Y.Z'` is the migration's target version.
- The `MigrationResult.actions` array must include a description of the version update (e.g. `Updated yg-config.yaml: version → X.Y.Z`) when `updateConfigVersion()` is called.
- If `updateConfigVersion()` fails (e.g. `yg-config.yaml` is missing), the failure must be captured as a `warnings` entry in the returned `MigrationResult`, not re-thrown as an error.
- The migration must NOT return `bumpVersion: false`.

### Pattern B — runner writes the version, gated by warnings

- The migration does NOT call `updateConfigVersion()` directly. Version bookkeeping is delegated to `runVersionUpgrade` (in `core/migrator-runner.ts`), which calls `updateConfigVersion(yggRoot, toVersion)` once all registered migrations report success.
- The returned `MigrationResult` MUST include a `bumpVersion` boolean: `true` when the migration considers itself complete (the runner will then bump the version), `false` when warnings were emitted that the user must resolve before the version may move (the runner will then withhold the bump).
- The `actions` array must include a description of whether the version will be bumped — e.g. `Migration complete; the runner will bump yg-config.yaml version to X.Y.Z.` or `Migration partial: warnings emitted. Version will NOT be bumped.` — so the user-facing summary is unambiguous.
- The migration must NOT also call `updateConfigVersion()` directly; that would double-write and bypass the warnings gate.

### Always

- A migration that detects no changes are needed and returns early — before any write and with no warnings — must NOT call `updateConfigVersion()` itself. Under Pattern B it may still return `bumpVersion: true`; the runner will bump once, idempotently.

## Rationale

Two patterns exist because they solve different problems:

- Pattern A is the original contract — simplest when a migration succeeds unconditionally and there is no recoverable failure mode (the legacy `to-4.0.0` and `to-4.3.0` migrations follow this pattern).
- Pattern B was introduced to let a migration emit recoverable warnings without leaving the project in a half-migrated state: by returning `bumpVersion: false`, the migration tells the runner "I wrote what I could; the version stays where it was so the user can re-run after fixing the listed problems." Without Pattern B, the version would advance silently even when warnings indicated the user must intervene.

Mixing patterns inside one migration breaks the runner's invariant: either the migration owns version writes (Pattern A), or the runner does (Pattern B). Doing both writes twice; doing neither leaves the version stale and re-runs the migration unnecessarily.
