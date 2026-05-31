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
## [2026-05-28T11:11:18.488Z]
Cascade follow-through: dependency cli/formatters added a new shared message-builder module file to its mapping. No call-site or contract changed for build-context — the new builder is consumed only by the aspect parser. Re-approve sweep keeps the build-context node aligned with the refreshed upstream metadata.
## [2026-05-29T10:05:51.028Z]
Test suite for this command was updated to reflect the redesigned yg check output format. The old format had section headers (Structural:, Cascade summary:), per-node cascade repetition, and a Result: footer. The new format uses a single-line verdict header, grouped cascade blocks, and Why:/Fix: labelled output. Tests that asserted the old format strings were updated to the equivalent new format assertions.
## [2026-05-31T14:14:22.666Z]
Asking for the context of a node that does not exist is an ordinary user mistake — usually a mistyped path or a path that still includes the model prefix — yet it was surfaced through the catch-all handler reserved for genuine internal failures, which tells the user the CLI hit an unclassified error and that this is a bug to be reported. That is both wrong and unhelpful. The node-not-found case is now recognized explicitly before reaching the catch-all and rendered with the same what/why/next structure as every other diagnostic: it states which node is missing, explains that the node path must name an existing node directory under the model tree written without that prefix, and points to the tree and find commands for locating a valid one.
## [2026-05-31T14:21:42.285Z]
Requesting the context of a node that does not exist is a routine user mistake and must read as one. The not-found case is recognized before the catch-all crash handler and rendered with a structured what/why/next that names the missing node, explains the node path must identify an existing node directory under the model tree written without that prefix, and points to the browse and search commands — rather than telling the user the CLI hit an unclassified internal error to be reported as a bug. The helper that builds that structured message is shared from the formatters layer and is imported once at the top of this file.
