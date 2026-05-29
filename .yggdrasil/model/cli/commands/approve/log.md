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
## [2026-05-26T10:18:20.285Z]
Rewrote aspect command-exit-codes against raw tree-sitter API. Hash change forces re-approval. Verified behavior-identical via ast-test diff against pre-rewrite baseline.
## [2026-05-26T10:27:54.432Z]
Rewrote aspect command-contract-shape against raw tree-sitter API. Replaced ast.exports() helper and string-based ast.inFile() with walk() + raw node traversal and inFile({glob:...}) object form. Verified behavior-identical via ast-test diff.
## [2026-05-27T07:22:10.321Z]
Phase 6 type-bridge: updated loadLlmProvider to read from graph.config.reviewer.tiers (v5 ReviewerConfig) instead of graph.config.llm (removed field); updated AST aspect filter comparisons from reviewer === 'ast' to reviewer?.type === 'ast' to match AspectReviewerSpec object shape.
## [2026-05-27T11:11:27.045Z]
Added a validator gate that aborts before any LLM call when structural errors in the graph would prevent valid tier resolution. The gate runs validate(graph) and filters to a fixed set of error codes that indicate misconfigured reviewer tiers, invalid aspect reviewer fields, or secrets validation problems. If any gating error is present, approve exits with a structured diagnostic rather than proceeding to provider invocation where the error would surface as a confusing failure. The secretsByProvider session cache is now initialized once per batch invocation (including single-node calls) and passed through to runApproveWithReviewer to enable cross-node secrets deduplication.
## [2026-05-27T11:39:55.400Z]
Removed unused AstRunnerError import; fixed what-why-next layering violation by wrapping gating-error output in buildIssueMessage; changed dry-run AST error output from stdout to stderr and wrapped in buildIssueMessage to satisfy cli-command-contract.
## [2026-05-28T08:51:10.667Z]
Extended dry-run preview to load and include aspect references in the prompt. When --dry-run is used with an LLM aspect that declares references, the preview now calls loadAndIsolateReferences so the prompt output includes the <references> block with the actual file content, matching what the real approve run sends to the LLM reviewer. A yellow warning is emitted if reference loading fails. This ensures agents using dry-run to inspect prompts see the complete reviewer context rather than a truncated version without reference files.
## [2026-05-28T10:05:21.361Z]
Changed dry-run LLM aspect display from single-first-aspect to a loop over all LLM aspects. Each iteration loads references via the shared refsCache (per-invocation cache), builds the prompt, and prints a labeled section header matching the real-run behavior. Warning messages now include the aspect ID for clarity. This aligns dry-run output with real-run behavior: every aspect a node has will be shown, not just the first, giving agents a complete preview of what the reviewer will see.
## [2026-05-28T12:37:08.853Z]
CLI surface for draft-aware approve. The --aspect X gate now checks the aspect default before launching the batch — when X is itself draft, exit 0 with Scenario A guidance instead of dispatching reviewer calls that would all be skipped. Inside the per-node loop a Scenario B short-circuit runs first, printing the friendly per-node reason and recording the skip without consulting approveNode. The batch footer now reports the draft skip tally alongside approved/failed when any aspect was skipped, so callers see why the active set is smaller than the cascade list.
## [2026-05-28T12:55:03.342Z]
Thread prior drift baseline into the reviewer so per-aspect verdicts survive filtered approves. runLlmVerification now reads the stored drift entry up-front and passes it to the reviewer; in a per-aspect approve run, prior verdicts on aspects outside the filter are preserved rather than dropped. Without this, a focused approve on one aspect would erase verdicts for every other aspect on the node, defeating the purpose of recording per-aspect state.
## [2026-05-28T13:46:57.365Z]
Approve --node Y treats all-draft nodes as no reviewer work. When every effective aspect on a target node resolves to status 'draft', the command emits a clear 'reviewer skipped' message and exits 0 before any reviewer dispatch, mirroring the existing --aspect Scenario A short-circuit. The dry-run preview is now status-aware: each aspect prompt is annotated with its effective status tag, and draft aspects carry an explicit note that real approve would skip them — keeping dry-run useful as a preview even for dormant rules. Extracted the dry-run per-node loop into an exported helper so the status-tagging behaviour can be exercised by unit tests without spawning a child process.
## [2026-05-29T10:05:50.728Z]
Test suite for this command was updated to reflect the redesigned yg check output format. The old format had section headers (Structural:, Cascade summary:), per-node cascade repetition, and a Result: footer. The new format uses a single-line verdict header, grouped cascade blocks, and Why:/Fix: labelled output. Tests that asserted the old format strings were updated to the equivalent new format assertions.
## [2026-05-29T10:07:13.746Z]
Cascade from check.test.ts update: the sibling test file for the check command was updated to match the new output format.
## [2026-05-29T12:49:55.934Z]
The preview path for the approve command now routes every reviewer kind through the same per-aspect classification the real verification uses. Previously the preview split aspects into only two buckets — one exact kind and an everything-else catch-all — so a graph-shape-verified aspect was swept into the natural-language-reviewer preview, which assembled a prompt that the real run would never send to a language model. A graph-shape aspect requires no language model; its preview must run the same shape check the real path runs. Keeping preview and real verification on one shared classification means adding a new reviewer kind in the future cannot silently desync the two again.
## [2026-05-29T16:20:43.186Z]
The approve command no longer exits non-zero when the only aspect violations are of advisory-status aspects. For an advisory-only set the node is treated as passed for exit-code purposes and the violations are printed as an informational, non-blocking line rather than a red refusal; the per-aspect verdict and baseline are still recorded. Only an enforced violation (or a mix containing one) makes the command exit 1. This matches advisory's warns-but-does-not-block semantics and keeps the single, batch, and filtered exit paths consistent.
