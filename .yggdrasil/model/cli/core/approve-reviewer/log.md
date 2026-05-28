## [2026-05-15T15:49:31.286Z]
R0.2: new engine module — LLM verification orchestration extracted from cli/approve.ts. Runs verifyAspects on non-AST aspects, classifies provider vs code violations, commits drift state on pass. Avoids adding network-calling code to cli/core/approve which has the deterministic aspect.
## [2026-05-15T18:26:28.936Z]
Add yg-suppress(deterministic) at file level — approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
## [2026-05-15T19:28:50.216Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-16T03:56:28.692Z]
Replace path.sep with split(/[\\/]/) to remove platform-specific separator — posix-paths-source aspect compliance.
## [2026-05-16T04:34:29.494Z]
Add filterAspectId to ApproveWithReviewerInput — when set, LLM aspects are filtered to only the specified aspect ID. Enables targeted cascade approve from approve --aspect X.
## [2026-05-16T05:58:05.365Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T19:44:32.124Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-26T08:07:11.366Z]
Update approve-reviewer.ts to derive providerError from errorSource discriminator on AspectVerificationResult. Uses errorSource === 'provider' || 'astRuntime' to identify infrastructure errors (rather than the deprecated providerError boolean). Keeps backward-compatible providerError field on the violations array for downstream consumers until Task 3 migrates them.
## [2026-05-26T08:33:17.135Z]
Filter logic now distinguishes infrastructure failure (errorSource !== codeViolation) from code violations (errorSource === codeViolation). Refuse message references infrastructureErrors instead of providerErrors. Generalizes 'not a code violation' rule to AST runtime exceptions too.
## [2026-05-26T08:42:37.333Z]
Added normalizedNodePath to normalize nodePath before embedding in output strings. posix-paths-output aspect requires paths written to output or stored in return values to have backslashes replaced with forward slashes and trailing slashes stripped.
## [2026-05-27T07:22:17.005Z]
Phase 6 type-bridge: updated graph.config.llm reference to graph.config.reviewer.tiers bridge pattern; updated reviewer comparison from a.reviewer !== 'ast' to a.reviewer?.type !== 'ast' to match AspectReviewerSpec object shape.
## [2026-05-27T11:11:19.079Z]
Rewrote verifier orchestration to use per-tier batching: aspects are grouped by their assigned LLM tier before any provider call, so one provider instance handles all aspects for its tier in a single verifyAspects invocation. Session-scoped secrets caching (secretsByProvider map passed in by caller) prevents redundant secrets-file reads across nodes in a batch approve. AST aspects run locally before any LLM tier group, allowing early refusal without an LLM call. The execution plan (resolveExecutionPlan) is computed up front and returns structured errors rather than throwing, so the caller can decide how to present tier-resolution failures. The yg-suppress(deterministic) waiver at file scope covers the inherent non-determinism of the LLM provider calls that this orchestrator makes.
## [2026-05-28T08:42:03.066Z]
Added loadAndIsolateReferences exported helper with per-aspect reference file loading, read cache (Map scoped to invocation), UTF-8 BOM stripping, and failure isolation. When a reference file cannot be read, the aspect is removed from the tier batch and a synthetic refused result (errorSource: provider, reason prefixed LLM_REFERENCE_UNREADABLE) is injected directly into allAspectResults — mirroring how AST runtime errors are isolated. The rest of the tier batch proceeds unaffected. The referencesCache is created inside runApproveWithReviewer so each invocation has its own scope. readTextFile is imported from io/graph-fs.ts per the no-direct-fs constraint.
## [2026-05-28T10:05:28.863Z]
Added a distinct refuseReasonData path for LLM_REFERENCE_UNREADABLE failures. Previously these were routed through the generic infrastructure-error message ('provider connection or authentication error'), which was misleading since the failure is a missing or unreadable file, not a provider issue. The new check inspects aspectViolations for entries whose reason starts with LLM_REFERENCE_UNREADABLE, and if any are present (with no code violations), emits a specific message naming the failing aspect IDs and directing the agent to restore or fix the reference file. This check is positioned before the generic infra-error block so it takes precedence. Also fixed lowercase-first style on the generic infra-error why: field.
