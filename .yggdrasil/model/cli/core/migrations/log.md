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
## [2026-05-16T07:16:25.354Z]
Fix to-4.0.0.ts: remove inline version bump from cleanConfig, call updateConfigVersion() at end of migrateTo4() conditioned on writes having occurred (schema-bump-bookkeeping). Fix to-4.4.0.ts: wrap updateConfigVersion() in try/catch, push failure to warnings instead of throwing.
## [2026-05-16T13:40:04.206Z]
Flatten 4.3.0+4.4.0 into single 4.3.0 release: merged to-4.4.0.ts (version-bump-only migration) into to-4.3.0.ts (adds log_required:false + when-predicate warning). Removed to-4.4.0.ts file and its MIGRATIONS entry. Updated index.ts description to reflect combined migration.
## [2026-05-26T10:31:31.810Z]
Rewrote aspect migration-bumps-version against raw tree-sitter API. Replaced ast.within() traversal with walk() + early return (false) on string and template_string nodes. Verified behavior-identical via ast-test diff.
## [2026-05-27T11:59:10.017Z]
Added to-5.0.0.ts migration: transformConfigReviewer converts v4 reviewer format (provider keys + active selector directly under reviewer:) to v5 tiers structure; transformAspectReviewer converts reviewer: string shorthand to reviewer: { type: ... } mapping. Registered in migrations/index.ts as version 5.0.0 migration.
