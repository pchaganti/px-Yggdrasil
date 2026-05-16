## [2026-05-15T09:51:42.481Z]
Fix no-explicit-any ESLint warning: catch (e: any) → catch (e: unknown) with explicit cast
## [2026-05-15T17:52:30.885Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that exits without re-throwing.
## [2026-05-16T05:58:00.894Z]
Phase 4.7 (no-direct-fs): update hash and paths imports from utils/ to io/ following move of these modules to persistence-adapter layer
## [2026-05-16T17:37:13.303Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.033Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
