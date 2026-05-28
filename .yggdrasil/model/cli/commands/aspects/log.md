## [2026-05-16T05:57:54.659Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T17:37:13.178Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:19.910Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-16T19:31:39.148Z]
Updated effective-aspects import path to core/graph/aspects.
## [2026-05-27T07:22:10.452Z]
Phase 6 type-bridge: updated reviewer display from aspect.reviewer ?? 'llm' to aspect.reviewer?.type ?? 'llm' to match the new AspectReviewerSpec object shape replacing the former string union.
## [2026-05-27T13:54:31.635Z]
Display the resolved reviewer tier (or "(default)") alongside the type so authors see which named tier the aspect will use at approve time.
