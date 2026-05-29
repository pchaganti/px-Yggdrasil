## [2026-05-28T05:10:00.191Z]
Init-upgrade unit test signature updated to match the runner-driven contract; the toVersion argument is no longer threaded through the wrapper.
## [2026-05-28T13:14:00.071Z]
Updated makeCheckResult helper to include the new advisoryWarnings and draftSkipped fields on CheckResult so test fixtures construct valid CheckResult objects after the type extension in cli/core/check.
## [2026-05-28T14:02:00.645Z]
Add tests covering status field population on aspect entries returned by buildNodeContextData and buildFileContextData. Tests load the sample-project fixture, build context data, and assert every aspect entry has a status of draft / advisory / enforced so downstream formatters can render it without a fallback dance.
## [2026-05-29T09:34:29.682Z]
Added unit tests for five commands that previously had no sibling test coverage: ast-test, build-context, init, structure-test, and tree. Each test verifies the command registers under its expected name and exposes its required options. These were the last commands needing coverage to allow the sibling-test-file aspect to be promoted from draft to enforced across all command nodes.
## [2026-05-29T09:50:58.923Z]
Added check-render.test.ts to this node's mapping. The file was created by a background refactor of the check output renderer and needed graph coverage to resolve a strict-orphan enforcement error. The file tests rendering concerns separate from the check command's orchestration logic.
## [2026-05-29T09:55:54.318Z]
check.test.ts updated by a concurrent refactor of the check output renderer to match the new header format. The test now uses yg-check-prefixed assertions instead of the old 'Result:' format.
## [2026-05-29T09:56:57.013Z]
Added check-render.test.ts with 30 tests for the new terse yg check output format. Updated check.test.ts (12 tests) to reflect that the old Structural: section headers, Cascade summary: block, and 23-files-satisfy-strict grouping logic no longer exist in the renderer — replaced with assertions on the new format. Updated aspect-status-lifecycle.test.ts to match the new header format.
## [2026-05-29T10:07:14.593Z]
check.test.ts updated to match the new grouped yg check output format. Added check-render.test.ts to this node's mapping for coverage of the new check renderer module.
