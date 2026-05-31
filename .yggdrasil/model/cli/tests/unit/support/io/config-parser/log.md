## [2026-05-31T21:54:30.854Z]
Removed the 'v4 to legacy errors' describe block and three legacy/mixed code cases from config-parser.test.ts. These tests asserted codes (config-reviewer-legacy-format, config-reviewer-mixed-format) that the parser no longer emits after legacy detection was relocated to migration-only. The remaining tests cover the current 5.0 format validation paths.
