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
## [2026-05-16T17:37:13.431Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.160Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-28T07:49:26.246Z]
Normalize resolvedFilePath via the canonical .replace(/\/g, '/').replace(/\/+$/, '') pair before passing it to buildFileContextData. The unnormalized result.file flowed into formatFileContext output via FileContextData.filePath, exposing stdout to backslash separators on Windows-native paths. Surfaced during cascade re-approve after the cli/io/parsers node split; the issue pre-existed but the reviewer caught it on this pass.
