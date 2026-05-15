## [2026-05-15T06:24:48.183Z]
Add reviewer isolation: spawn from tmpdir (no CLAUDE.md loaded) and pass isolation flags to claude-code provider (no tools, skills, hooks, MCP, session persistence, or dynamic system prompt sections). Prevents caller-side context from polluting LLM reviewer verdicts.
