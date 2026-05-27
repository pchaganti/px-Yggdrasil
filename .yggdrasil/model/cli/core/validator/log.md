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
## [2026-05-15T07:32:22.551Z]
Add checkFileMappingGitignored: emits file-mapping-gitignored when a concrete file in a node mapping is excluded by .gitignore (root or cascading). Uses walkRepoFiles to build the tracked-file set, then flags mapping entries absent from it. Only fires for files that exist on disk (not typo errors).
## [2026-05-15T08:09:40.563Z]
Add checkStrictBackwardCoverage: scans all repo files against each strict type's when predicate, emitting type-strict-orphan (file matches strict type but unmapped), type-strict-misplaced (file mapped to wrong-type node), and strict-overlap-conflict (two strict types' when predicates overlap — one error per ordered pair). Overlap detection supersedes orphan/misplaced for conflicting files. Also fixed checkStrictBackwardCoverage tests: intermediate directories without yg-node.yaml are not scanned by loadGraph; tests now use flat (one-level) node paths.
## [2026-05-15T08:14:21.206Z]
Split file-duplicate-mapping from overlapping-mapping: exact path duplicate in two nodes now emits file-duplicate-mapping (new code); containment (non-ancestor) continues to emit overlapping-mapping. Updated two test cases that were checking overlapping-mapping on exact duplicates.
## [2026-05-15T12:12:58.789Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:34:39.053Z]
R0.4: file-content-cache import updated from ./file-content-cache to ../io/file-content-cache (no logic change)
## [2026-05-15T13:55:50.486Z]
R0.1 Phase 4: populate messageData via issueMsg() helper on every ValidationIssue. buildIssueMessage still called for backward compat message field; Phase 5 will drop message.
## [2026-05-15T14:17:01.550Z]
Drop deprecated message field: issueMsg() returns only messageData; buildIssueMessage import removed; de-duplication uses messageData.what. R0.1 Phase 5.
## [2026-05-15T19:28:50.442Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-16T05:58:05.841Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T13:56:23.582Z]
Fix what-why-next violation: read messageData from nodeParseErrors and architectureError instead of reconstructing IssueMessage inline. Align with updated Graph model where nodeParseErrors stores IssueMessage and architectureError removes bare string variant.
## [2026-05-16T17:00:56.632Z]
Removed duplicate collectAncestors in effective-aspects.ts; now imports the canonical root-first implementation from context-builder. Reason: the local version returned leaf-first (push) while the exported version returns root-first (unshift); two definitions with opposing orderings would silently reverse traversal if a future caller imported the wrong one. Order is irrelevant for the two existing call sites (both iterate ancestors as a set to test membership). Eliminated the bug-in-waiting.
## [2026-05-16T19:31:38.646Z]
Removed effective-aspects.ts from mapping; the file moved to core/graph/aspects.ts under the cli/core/graph node. validator.ts import path updated accordingly.
## [2026-05-26T10:00:43.918Z]
Four new structural error codes for AST aspect language field: missing-required, scalar-not-array, empty-list, unknown-language. Imports LANGUAGES from core/graph/language-registry per existing core→core/graph precedent. LLM aspects retain optional language field with same registry membership check.
## [2026-05-27T07:22:23.992Z]
Phase 6 type-bridge: updated reviewer comparisons from string form (aspect.reviewer === 'ast') to object form (aspect.reviewer.type === 'ast'); updated checkAspectReviewerEnum to use aspect.reviewer.type; updated checkAspectRuleSources to derive reviewer from aspect.reviewer.type.
## [2026-05-27T08:00:17.924Z]
Updated the when-predicate-invalid branch to access archErr.messageData (IssueMessage) instead of archErr.message (string). This aligns with the ArchitectureLoadError type change: the when-predicate-invalid variant now uses messageData: IssueMessage instead of message: string, matching the architecture-invalid variant and satisfying the what-why-next aspect requirement that engine-returned diagnostics carry structured IssueMessage.
## [2026-05-27T09:16:11.504Z]
Updated validator to use configErrorMessage (IssueMessage) when available, falling back to the plain configError string for backward compatibility. This ensures structured what/why/next propagation is preserved through the validation pipeline for structured config parse errors (ConfigParseError), while unstructured parse errors (generic Error) continue to work as before. The error code in the ValidationIssue now comes from graph.configErrorCode when present, defaulting to 'config-invalid'.
