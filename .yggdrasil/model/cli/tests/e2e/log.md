## [2026-05-16T09:47:12.887Z]
Add e2e coverage for all CLI commands: flows, find, context --file, log add/read/read-all, ast-test (error paths + clean check via dogfood), type-suggest, knowledge list/read, approve --dry-run
## [2026-05-16T09:58:38.106Z]
Add comprehensive e2e coverage: all CLI commands, every flag, happy paths and error cases — 107 tests total (was 73)
## [2026-05-16T10:03:34.198Z]
Fix approve --aspect/--flow tests to use isolated tmpDir copies of fixture (preventing fixture pollution); coverage now 107 tests
## [2026-05-27T12:37:42.506Z]
Fixed e2e assertion for v4 config rejection test: changed expected substring from 'legacy' to 'pre-v5' to match the actual error message emitted by config-parser.ts when it detects a pre-v5 reviewer format.
## [2026-05-27T13:54:57.123Z]
Updated the legacy-config e2e test to match the reworded migration-hint message and to also assert that the next-step text points at yg init upgrade.
## [2026-05-28T05:09:55.143Z]
E2E coverage updated for the runner-driven incremental bump contract. The version-bumped-after-upgrade assertion now reads the highest registered migration target instead of the CLI package version, since the runner advances the on-disk version to each migration target and never forces a CLI-version override.
## [2026-05-28T19:46:23.565Z]
Updated e2e impact --file assertion: file->nodePath resolution line now arrives on stdout (was stderr) following cli/commands/impact stdout-routing fix. Test now asserts the full 'src/orders/order.service.ts -> orders/order-service' text appears on stdout.
