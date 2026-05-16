## [2026-05-16T05:57:54.659Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T17:37:13.178Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
