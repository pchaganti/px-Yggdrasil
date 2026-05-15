## [2026-05-15T09:13:17.308Z]
Add to-4.4.0.ts migration: pre-checks current version is 4.3.0, writes 4.4.0 to yg-config.yaml, returns warnings describing new 4.4.0 validation rules (type-when predicates, organizational types, enforce:strict). Register in migrations/index.ts.
## [2026-05-15T09:17:13.402Z]
Fix migrateTo44: remove strict version pre-check (was checking for exactly 4.3.0). The orchestrator doesn't update yg-config.yaml between migrations, so migrateTo43 leaves the version at 4.0.0 when called from that version. Now only check that version field exists; also use dynamic current version in the actions message.
