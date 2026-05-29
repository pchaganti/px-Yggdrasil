## [2026-05-15T16:21:06.490Z]
New module: logAdd, logRead, logMergeResolve extracted from cli/log-add.ts, cli/log-read.ts, cli/log-merge-resolve.ts. Functions return structured IssueMessage-shaped results — no chalk, no process.exit, no formatters calls.
## [2026-05-15T16:28:14.146Z]
R0.10: extracted log-add, log-read, log-merge-resolve from cli/ to core/log/ as pure orchestration functions returning structured IssueMessage results. Uses adapter type (not engine) because these functions do I/O via log-store.ts and generate timestamps (Date.now) — will be reclassified in Phase 2 when persistence-adapter type exists.
## [2026-05-15T18:26:29.054Z]
Add yg-suppress-disable/enable(deterministic) around monotonicNow — log entry datetime is functional output returned to caller; Date.now() use is a conscious design decision accepted here
## [2026-05-15T19:28:50.332Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-15T20:41:33.677Z]
Refactor logAdd to require nowMs parameter: move Date.now() call out of engine (log-add.ts) and into the CLI layer (log.ts). This satisfies the no-nondeterminism-direct AST aspect which forbids direct Date.now() calls in engine code.
## [2026-05-29T10:09:44.152Z]
Re-approving after drift state was wiped during concurrent development session. No source changes — this approval records the baseline verdicts for newly-active aspects.
## [2026-05-29T10:10:06.418Z]
Re-approving all aspects because the what-why-next aspect content was updated (clarified that structured messageData field access in CLI renderers satisfies the rule, not just direct buildIssueMessage calls). The aspect content change triggered a cascade drift requiring full re-approval to establish verdicts for all active aspects.
