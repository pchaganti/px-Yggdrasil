## [2026-05-15T09:51:39.112Z]
Fix no-explicit-any ESLint warnings: catch (e: any) → catch (e: unknown) with explicit casts
## [2026-05-15T10:11:11.465Z]
Fix dry-run node path normalization: align to contract pattern trim().replace(/\/$/, '')
## [2026-05-15T13:55:50.688Z]
R0.1 Phase 4: import AstRunnerError + buildIssueMessage; AstRunnerError catch now reads e.messageData to render error reason.
## [2026-05-15T14:17:00.919Z]
Drop deprecated refuseReason/message fields: cli/approve.ts now uses refuseReasonData for provider error and violation results; formatRefused reads refuseReasonData via buildIssueMessage. R0.1 Phase 5.
## [2026-05-15T15:48:44.813Z]
R0.2: thin cli/approve.ts — runLlmVerification now delegates LLM aspects to core/approve-reviewer::runApproveWithReviewer. AST aspects still handled at CLI layer. LlmApproveResult re-exported from core for backward compat.
## [2026-05-15T17:52:30.771Z]
Fix diagnostic-logging violations: add debugWrite() to catch blocks that swallow errors without re-throwing.
## [2026-05-16T03:56:28.408Z]
Replace path.sep with split(/[\\/]/) to remove platform-specific separator — posix-paths-source aspect compliance.
## [2026-05-16T04:34:29.373Z]
Add targeted aspect review: approve --aspect X now evaluates only aspect X per node (not all aspects) when no source drift exists. Pass filterAspectId through runBatchApprove → runLlmVerification. Source drift still triggers full re-verification.
## [2026-05-16T05:57:54.530Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T08:39:07.251Z]
formatRefused: use buildIssueMessage instead of raw stderr writes; aspect/flow not-found: use buildIssueMessage — satisfies what-why-next aspect added via approve flow
## [2026-05-16T17:37:13.056Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:19.786Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-16T19:44:32.516Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-16T20:03:20.779Z]
Wrapped 'Approve refused.' fallback string and 'No reviewer configured' Error in buildIssueMessage. Both contained agent-facing remediation guidance and were flagged by the what-why-next reviewer.
## [2026-05-26T08:33:21.273Z]
AST aspect execution sets errorSource: 'codeViolation' in success path, errorSource: 'astRuntime' in catch. AST violations map includes errorSource from result. Aligns with new AspectVerificationResult and ApproveResult shapes; AST runtime exceptions now flow through 'not a code violation' filter alongside LLM provider failures.
## [2026-05-26T08:42:33.030Z]
Changed loadLlmProvider to handle the 'No reviewer configured' case inline (process.stderr.write + process.exit) instead of throwing an Error that would be caught by the generic abortOnUnexpectedError handler. Constant-text command errors must be handled inline per cli-command-contract; routing known errors through abortOnUnexpectedError produces misleading 'Unexpected error' output.
