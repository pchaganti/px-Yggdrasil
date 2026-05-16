## [2026-05-16T09:47:12.887Z]
Add e2e coverage for all CLI commands: flows, find, context --file, log add/read/read-all, ast-test (error paths + clean check via dogfood), type-suggest, knowledge list/read, approve --dry-run
## [2026-05-16T09:58:38.106Z]
Add comprehensive e2e coverage: all CLI commands, every flag, happy paths and error cases — 107 tests total (was 73)
## [2026-05-16T10:03:34.198Z]
Fix approve --aspect/--flow tests to use isolated tmpDir copies of fixture (preventing fixture pollution); coverage now 107 tests
