## [2026-05-28T05:10:00.191Z]
Init-upgrade unit test signature updated to match the runner-driven contract; the toVersion argument is no longer threaded through the wrapper.
## [2026-05-28T13:14:00.071Z]
Updated makeCheckResult helper to include the new advisoryWarnings and draftSkipped fields on CheckResult so test fixtures construct valid CheckResult objects after the type extension in cli/core/check.
## [2026-05-28T14:02:00.645Z]
Add tests covering status field population on aspect entries returned by buildNodeContextData and buildFileContextData. Tests load the sample-project fixture, build context data, and assert every aspect entry has a status of draft / advisory / enforced so downstream formatters can render it without a fallback dance.
## [2026-05-29T09:34:29.682Z]
Added unit tests for five commands that previously had no sibling test coverage: ast-test, build-context, init, structure-test, and tree. Each test verifies the command registers under its expected name and exposes its required options. These were the last commands needing coverage to allow the sibling-test-file aspect to be promoted from draft to enforced across all command nodes.
