# Schema Bump Bookkeeping

A migration must NOT write the project version itself. The migration runner
(`runVersionUpgrade` in `core/migrator-runner.ts`) is the sole writer of the
`version` field in `yg-config.yaml`: it advances the version one step per
successfully-completed migration, after that migration reports success.

## Rules

- A migration MUST NOT call `updateConfigVersion()` (or otherwise write the
  `version` field of `yg-config.yaml`). Version bookkeeping is delegated to the
  runner, which calls `updateConfigVersion(yggRoot, migration.to)` once the
  migration reports success.
- A migration MAY withhold the bump by returning `bumpVersion: false` in its
  `MigrationResult`. This is the recoverable-failure path: when the migration
  emits warnings the user must resolve before the version may move, it returns
  `bumpVersion: false` and the runner leaves the version where it was, so the
  user can fix the listed problems and re-run. A migration that considers itself
  complete returns `bumpVersion: true` (or omits the field — the runner treats
  an absent `bumpVersion` as `true`).
- The `actions` array SHOULD describe whether the version will move — e.g.
  `Migration complete; the runner will bump yg-config.yaml version to X.Y.Z.`
  or `Migration partial: warnings emitted. Version will NOT be bumped.` — so the
  user-facing summary is unambiguous.
- A migration that detects no changes are needed and returns early — before any
  write and with no warnings — needs no special bookkeeping. It may return
  `bumpVersion: true` (the runner bumps once, idempotently) and writes nothing
  itself.

## Rationale

A single writer keeps the version monotonic and the warnings gate honest. If a
migration also wrote the version directly, it would double-write and bypass the
`bumpVersion: false` gate — the version could advance silently even when
warnings indicated the user must intervene. Delegating every version write to
the runner means the version moves exactly when, and only when, the runner
decides each migration has completed successfully.
