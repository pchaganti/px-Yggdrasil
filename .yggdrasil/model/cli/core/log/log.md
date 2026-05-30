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
## [2026-05-30T10:05:16.434Z]
Merge reconciliation of a per-node history now verifies entries by their full content, not just their timestamp, and in both directions. Matching only on timestamp let a reconciliation silently keep an entry whose text had been altered, or add an entry present on neither merged branch, as long as the timestamps lined up. Reconciliation now rejects dropped, altered, and fabricated entries alike, and reports a clear, actionable message when the history file is absent instead of failing with an opaque error.
## [2026-05-30T10:28:16.596Z]
The merge-reconciliation path that handles an unreadable per-node history file now writes a diagnostic log line before returning its user-facing error, so a swallowed read failure is never silent. This follows the codebase convention that any caught error which is not re-thrown must still be recorded for later diagnosis, rather than disappearing into a fallback return.
