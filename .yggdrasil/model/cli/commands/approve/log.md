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
