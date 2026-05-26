## [2026-05-15T06:24:48.183Z]
Add reviewer isolation: spawn from tmpdir (no CLAUDE.md loaded) and pass isolation flags to claude-code provider (no tools, skills, hooks, MCP, session persistence, or dynamic system prompt sections). Prevents caller-side context from polluting LLM reviewer verdicts.
## [2026-05-15T17:44:40.056Z]
Phase 2: reclassified from adapter to llm-provider. Removed cli-base.ts (moved to cli/llm/subprocess-base).
## [2026-05-16T06:58:02.423Z]
Fix ollama.ts: replace raw fetch() and custom retry loop with apiFetch() from api-utils.ts — satisfies provider-retry-contract (retry responsibility belongs to apiFetch).
## [2026-05-26T08:03:04.147Z]
Migrate all 4 providers (anthropic, google, openai, ollama) to errorSource: 'provider' on infrastructure failures, errorSource: 'codeViolation' on real violations. Matches new required AspectResponse shape.
## [2026-05-26T10:44:29.781Z]
Rewrote aspect provider-redaction against raw tree-sitter API. Verified behavior-identical via ast-test diff.
