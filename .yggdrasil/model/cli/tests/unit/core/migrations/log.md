## [2026-05-16T13:40:11.952Z]
Remove to-4.4.0.test.ts (function deleted), add warning test to to-4.3.0.test.ts. Integration test renamed migration-4.3-to-4.4 → migration-4.2-to-4.3, starting version 4.2.0 → 4.3.0. Part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
## [2026-05-27T10:12:59.554Z]
Phase 9: added runVersionUpgrade test in migrator.test.ts to cover the bumpVersion:false branch in migrator-runner.ts, increasing branch coverage above the 90% threshold. The test verifies that when a migration returns bumpVersion: false, the version string in yg-config.yaml is not updated.
## [2026-05-27T11:59:10.131Z]
Added to-5.0.0.test.ts: 20 tests covering transformConfigReviewer and transformAspectReviewer pure functions, plus migrateTo50 integration tests for config migration, aspect migration, idempotency, and missing-file handling.
## [2026-05-27T12:03:50.983Z]
Added 4 more tests covering edge-case branches in to-5.0.0.ts: aspect dir with no yg-aspect.yaml, invalid YAML in aspect file, updateConfigVersion failure when no config exists, and multiple providers without active key.
## [2026-05-27T13:55:02.636Z]
Migration unit tests rewritten to assert the corrected per-provider tier preservation, the new bumpVersion-on-warnings gate, and the unknown-string and missing-type warning paths. Earlier tests that locked in the wrong collapsed-to-standard behaviour were replaced.
## [2026-05-28T05:10:01.877Z]
Migrator unit test no longer passes a toVersion to runVersionUpgrade. The runner reads the current version from the seeded config, runs the mock migration, and verifies that no bump occurs when bumpVersion is false.
