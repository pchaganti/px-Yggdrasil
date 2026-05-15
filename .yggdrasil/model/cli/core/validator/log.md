## [2026-05-15T06:43:15.644Z]
Restructure validate() pipeline: Stage 1 handles architectureError (architecture-invalid/when-predicate-invalid, returns early); Stage 2 schema-independent checks always run; Stage 3 architecture-level checks (type-unknown-parent implemented, cycles/enforce stubs) short-circuit per-node + global stages on fatal errors; Stages 4/5 stubs wired for future implementation.
## [2026-05-15T06:47:52.136Z]
Implement checkTypeWithoutWhenWithMapping: emits type-without-when-with-mapping error when a node's type has no when predicate (organizational type) but the node's mapping is non-empty.
## [2026-05-15T06:58:19.218Z]
Add checkArchitectureParentCycles: two-pass DFS+BFS cycle detection. Pass 1 (DFS three-color) identifies back-edges forming cycles. Pass 2 (BFS per type excluding back-edges) emits architecture-cycle only when no rootable type reachable, allowing self-loops with alternative parents (escape path exists). Runs only after checkTypeUnknownParent passes (skips if dangling parents exist). Spec §9.
## [2026-05-15T07:00:20.290Z]
Fix: wrap architectureError branches in buildIssueMessage (what-why-next aspect). Both when-predicate-invalid and architecture-invalid branches were passing raw strings directly as message. Now use structured format per aspect requirement.
## [2026-05-15T07:05:26.982Z]
Add checkEnforceStrictWithoutWhen: emits enforce-strict-without-when when type declares enforce: strict without a when predicate. enforce: strict without when is meaningless — no files to evaluate against. Spec §7 Klasa 5.
## [2026-05-15T07:15:16.618Z]
Add checkTypeWhenMismatch: per-node check evaluating each mapped file against the node type's when predicate. Emits type-when-mismatch with predicate trace on failure. Emits file-unreadable (not type-when-mismatch) for files that cannot be opened. Imports evaluateFileWhen and renderTrace.
## [2026-05-15T07:18:26.460Z]
Fix: scope-filter block was passing raw parseError.message instead of buildIssueMessage. Now uses structured what/why/next.
## [2026-05-15T07:22:55.685Z]
Fix: scope-filter block was passing raw parseError.message as issue message instead of buildIssueMessage. Now uses structured what/why/next format to satisfy what-why-next aspect.
## [2026-05-15T07:28:53.036Z]
Fix checkTypeWhenMismatch: unreadable issues were collected but never merged into the main issues list. Now allUnreadable accumulates from Stage 4 (whenMismatch) and Stage 5 (strict), de-duplicated by message, then pushed into issues.
