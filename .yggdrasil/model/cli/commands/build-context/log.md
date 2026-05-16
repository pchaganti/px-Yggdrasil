## [2026-05-15T09:57:38.730Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T14:17:01.037Z]
Drop deprecated .message field: build-context.ts now renders ValidationIssue via buildIssueMessage(err.messageData). R0.1 Phase 5.
## [2026-05-15T14:23:01.259Z]
Fix ENOENT handler to use buildIssueMessage: 'Run yg init first' is a remediation command requiring structured what/why/next format per what-why-next aspect.
## [2026-05-15T14:25:36.164Z]
Fix node normalization: remove extra .replace(/^\.\//,'') not in cli-command-contract; restore ENOENT message to required verbatim string per cli-command-contract (what-why-next aspect updated to exempt this standardized string).
## [2026-05-15T17:52:31.033Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that exits without re-throwing.
## [2026-05-16T05:57:54.796Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T08:39:07.376Z]
Normalize result.file at output boundary (displayFile) before use in buildIssueMessage and stderr write — satisfies posix-paths-output aspect added via build-context flow
