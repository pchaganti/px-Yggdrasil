## [2026-05-16T13:40:11.952Z]
Remove to-4.4.0.test.ts (function deleted), add warning test to to-4.3.0.test.ts. Integration test renamed migration-4.3-to-4.4 → migration-4.2-to-4.3, starting version 4.2.0 → 4.3.0. Part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
## [2026-05-27T10:12:59.554Z]
Phase 9: added runVersionUpgrade test in migrator.test.ts to cover the bumpVersion:false branch in migrator-runner.ts, increasing branch coverage above the 90% threshold. The test verifies that when a migration returns bumpVersion: false, the version string in yg-config.yaml is not updated.
