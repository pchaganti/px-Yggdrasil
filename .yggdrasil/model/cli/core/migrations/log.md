## [2026-05-15T09:13:17.308Z]
Add to-4.4.0.ts migration: pre-checks current version is 4.3.0, writes 4.4.0 to yg-config.yaml, returns warnings describing new 4.4.0 validation rules (type-when predicates, organizational types, enforce:strict). Register in migrations/index.ts.
## [2026-05-15T09:17:13.402Z]
Fix migrateTo44: remove strict version pre-check (was checking for exactly 4.3.0). The orchestrator doesn't update yg-config.yaml between migrations, so migrateTo43 leaves the version at 4.0.0 when called from that version. Now only check that version field exists; also use dynamic current version in the actions message.
## [2026-05-15T19:37:33.718Z]
Add migration-bumps-version AST aspect to enforce that migration files reference their target version; fix to-4.3.0.ts to call updateConfigVersion('4.3.0') — it previously modified architecture YAML without bumping the schema version in config
## [2026-05-15T19:39:59.328Z]
Make updateConfigVersion call graceful (try/catch) and update test fixture to include yg-config.yaml so the migration properly exercises the version bump path in tests
## [2026-05-16T06:51:33.685Z]
Fix non-idempotent rm calls in to-4.0.0.ts: added force:true to rm() in processNodesRecursive and resetDriftStateRecursive so re-runs don't throw ENOENT on already-deleted files.
