## [2026-06-13T03:12:07.303Z]
Filling unverified verdicts is the single place a reviewer or a deterministic check executes, so it concentrates the fail-closed write discipline: a verdict is recorded only when the reviewer actually returned one, deterministic checks run first and gate the paid LLM dispatch, and a node's verdicts and source fingerprint advance together only when every enforced rule on it passes.
## [2026-06-13T03:16:12.633Z]
Every catch that returns a fallback instead of re-throwing emits a diagnostic line, and every path written to agent-facing output is normalized to forward slashes, so a swallowed read failure is never invisible and output never leaks platform-specific separators.
