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
