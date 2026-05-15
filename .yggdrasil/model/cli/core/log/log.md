## [2026-05-15T16:21:06.490Z]
New module: logAdd, logRead, logMergeResolve extracted from cli/log-add.ts, cli/log-read.ts, cli/log-merge-resolve.ts. Functions return structured IssueMessage-shaped results — no chalk, no process.exit, no formatters calls.
## [2026-05-15T16:28:14.146Z]
R0.10: extracted log-add, log-read, log-merge-resolve from cli/ to core/log/ as pure orchestration functions returning structured IssueMessage results. Uses adapter type (not engine) because these functions do I/O via log-store.ts and generate timestamps (Date.now) — will be reclassified in Phase 2 when persistence-adapter type exists.
