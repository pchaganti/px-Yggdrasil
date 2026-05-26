## [2026-05-12T10:49:07.334Z]
fix: log-integrity and log-format error codes were not displayed in Errors section of yg check output. Both codes were counted in error total but fell through all category filters (drift, cascade, structural, architecture, coverage, completeness). Added explicit Log: section in formatOutput to render them with full message.
## [2026-05-15T08:19:51.273Z]
Add strict coverage grouping in formatOutput: when >5 type-strict-orphan/misplaced/overlap errors, show grouped summary (count + 5 samples + '... (N more)'); expand STRUCTURAL_CODES to include all new when/enforce/type validation codes; add STRICT_CODES set and 'strict' category to result summary line.
## [2026-05-15T13:45:52.350Z]
R0.1 Phase 3: reads messageData via msg() helper to render issue output; buildIssueMessage now called at CLI layer instead of engine. Fallback to .message for issues not yet migrated.
## [2026-05-15T14:17:01.161Z]
Drop deprecated .message field: msg() helper simplified to buildIssueMessage(issue.messageData); architecture regex extraction updated to use messageData.what. R0.1 Phase 5.
## [2026-05-15T17:52:31.150Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that swallows git ls-files error.
## [2026-05-16T05:57:54.937Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T17:37:13.564Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.298Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-26T10:11:36.720Z]
Add 4 new aspect-language structural codes to STRUCTURAL_CODES (active CI-blocking set): aspect-ast-missing-language, aspect-language-not-array, aspect-empty-language-list, aspect-unknown-language. Behavioral verification confirms exit 1 fires from cli/check.ts set.
## [2026-05-26T10:44:58.641Z]
Rewrote aspect command-error-via-buildissuemessage against raw tree-sitter API. Verified behavior-identical via ast-test diff. No closest() import needed — uses raw parent walk.
