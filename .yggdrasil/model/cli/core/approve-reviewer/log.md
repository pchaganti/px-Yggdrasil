## [2026-05-15T15:49:31.286Z]
R0.2: new engine module — LLM verification orchestration extracted from cli/approve.ts. Runs verifyAspects on non-AST aspects, classifies provider vs code violations, commits drift state on pass. Avoids adding network-calling code to cli/core/approve which has the deterministic aspect.
## [2026-05-15T18:26:28.936Z]
Add yg-suppress(deterministic) at file level — approve-reviewer must invoke the configured LLM provider for verification; non-determinism is intentional and inherent to this engine's purpose
## [2026-05-15T19:28:50.216Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
