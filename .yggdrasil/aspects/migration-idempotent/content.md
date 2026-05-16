# Migration Idempotent

Every migration must be safe to run twice without corrupting or duplicating state. If a migration is interrupted and re-run, the result must be identical to a single clean run.

## Rules

- Migrations inspect current state before making changes to determine what work is actually needed. The standard mechanism is calling `detectVersion(yggRoot)` early; per-field or per-file state checks are equally acceptable alternatives.
- All write operations must be idempotent: writing the same value twice, creating a directory that already exists, or setting a field to the same value must leave state unchanged.
- Migrations must not append to files unconditionally — use replace or upsert semantics.
- A migration that has already applied its changes (detected via version or state inspection) must return without error, not fail or duplicate work.
- The `MigrationResult` returned must accurately describe what was actually changed, not what would have been changed on a fresh run.

## Rationale

Migrations run during `yg init --upgrade`. If the user interrupts the process mid-way and re-runs, each migration in the sequence will be called again for any version not yet recorded. Non-idempotent operations (double-appends, duplicate node creation) corrupt the graph. Idempotent operations make re-runs safe.
