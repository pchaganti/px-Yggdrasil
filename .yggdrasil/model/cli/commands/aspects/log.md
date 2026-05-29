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
## [2026-05-28T14:01:29.171Z]
Surface effective aspect status in yg aspects output. Each aspect row now renders [<status>] (defaulting to enforced when unset) right after the id, so adopters can see at a glance whether an aspect is draft, advisory, or enforced before running approve. Aspect-default status is graph-wide — per-node effective status appears in yg context / yg impact instead.
## [2026-05-29T10:05:50.865Z]
Test suite for this command was updated to reflect the redesigned yg check output format. The old format had section headers (Structural:, Cascade summary:), per-node cascade repetition, and a Result: footer. The new format uses a single-line verdict header, grouped cascade blocks, and Why:/Fix: labelled output. Tests that asserted the old format strings were updated to the equivalent new format assertions.
