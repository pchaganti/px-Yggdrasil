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
