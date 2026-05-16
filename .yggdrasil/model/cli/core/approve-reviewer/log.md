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
