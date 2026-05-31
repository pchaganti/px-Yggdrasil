## [2026-05-15T09:57:38.520Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T17:52:31.476Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that swallows access() error.
## [2026-05-16T05:57:55.359Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T17:37:14.178Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:21.182Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-16T18:46:28.448Z]
Removed unused chalk import after migrating error path to abortOnUnexpectedError; the surviving stdout writes use plain string formatting.
## [2026-05-29T10:05:51.469Z]
Test suite for this command was updated to reflect the redesigned yg check output format. The old format had section headers (Structural:, Cascade summary:), per-node cascade repetition, and a Result: footer. The new format uses a single-line verdict header, grouped cascade blocks, and Why:/Fix: labelled output. Tests that asserted the old format strings were updated to the equivalent new format assertions.
## [2026-05-29T10:07:13.877Z]
Cascade from check.test.ts update: the sibling test file for the check command was updated to match the new output format.
## [2026-05-31T16:03:31.938Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
## [2026-05-31T17:27:17.899Z]
Moved the shared command-layer support helpers — the graph-load-or-abort wrapper and the unexpected-error funnel — out of the formatters layer and into the command layer. These helpers must reach both the engine (to load the graph) and the formatters (to build the uniform what/why/next message), and only the command layer may legally depend on both; keeping them in the formatters layer was an upward dependency on the engine that the layering rules forbid. The helpers register no command of their own, so they live under a dedicated command-support classification rather than as a command handler. Command handlers now import them from their new command-layer location.
