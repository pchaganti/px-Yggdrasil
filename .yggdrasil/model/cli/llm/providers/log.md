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
## [2026-05-29T10:09:44.303Z]
Re-approving after drift state was wiped during concurrent development session. No source changes — this approval records the baseline verdicts for newly-active aspects.
## [2026-05-29T10:10:06.574Z]
Re-approving all aspects because the what-why-next aspect content was updated (clarified that structured messageData field access in CLI renderers satisfies the rule, not just direct buildIssueMessage calls). The aspect content change triggered a cascade drift requiring full re-approval to establish verdicts for all active aspects.
## [2026-05-31T14:27:08.824Z]
The Google reviewer provider authenticated by appending its API key to the request URL as a query parameter. A credential placed in a URL is exposed far more widely than one in a header: it is recorded in proxy, gateway, and server access logs, can appear in browser or tooling history, and surfaces in any error report or diagnostic that echoes the request URL. The key is now sent in the provider's dedicated authentication header and removed from the URL, which keeps the secret out of all those logging surfaces while remaining a fully supported way to authenticate.
