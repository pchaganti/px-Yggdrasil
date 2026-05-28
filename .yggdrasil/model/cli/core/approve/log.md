## [2026-05-12T11:24:00.198Z]
Extend mandatory log entry check to first approve: new nodes with source files now require a log entry on initial approve (when log_required: true). Gated by whether source files exist in mapping — logical nodes and log_required:false are unaffected. Fixes spec gap where spec data flow showed bootstrap failing without log entry.
## [2026-05-12T11:29:58.258Z]
Bootstrap mandatory log entry check: first approve on a node that has source files now requires at least one log entry when log_required is true (default). Previously the mandatory check was gated on storedEntry?.log, meaning it was skipped entirely for new nodes. Now the first-approve path checks log entries and returns refused if none exist. log_required: false still bypasses the check. Added three new unit tests in approve-log.test.ts and two integration tests in log-workflow.test.ts. Updated bootstrapApprove helper in integration tests to include a log entry before the first approve. Added log_required: false to sample-project fixture to isolate pipeline mechanics tests from log enforcement tests. Updated approve.test.ts to provide a log entry for the first-approve test.
## [2026-05-15T12:24:34.149Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:36:42.937Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.716Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.671Z]
R0.6: update log-parser import — approve.ts now imports parseLog from ./parsing/log-parser (moved from io/). No logic change.
## [2026-05-15T13:55:50.587Z]
R0.1 Phase 4: populate refuseReasonData alongside refuseReason on all refused ApproveResult returns. buildIssueMessage still called for backward compat; Phase 5 will drop refuseReason.
## [2026-05-15T14:17:01.278Z]
Drop deprecated refuseReason/buildIssueMessage: all approve refusals now set only refuseReasonData; buildIssueMessage import removed from core layer. R0.1 Phase 5.
## [2026-05-15T19:28:50.095Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-16T03:56:28.552Z]
Replace path.sep with split(/[\\/]/) to remove platform-specific separator — posix-paths-source aspect compliance.
## [2026-05-16T04:54:08.571Z]
Simplify annotateUpstreamChange: remove layer === 'flows' condition (dead code after flow YAML removed from tracked files) while keeping normalized.includes('/flows/') for old drift state compatibility.
## [2026-05-16T05:58:05.247Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T08:22:40.888Z]
Normalize filePath before pushing to changedSource/changedUpstream and normalize tf.path in sourcePathsFirst — raw paths were emitted to IssueMessage.what and returned in ApproveResult without POSIX normalization
## [2026-05-16T19:31:38.766Z]
Updated effective-aspects import path to core/graph/aspects following the file move.
## [2026-05-16T19:44:31.994Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-26T10:18:49.535Z]
Rewrote aspect no-direct-fs against raw tree-sitter API. Hash change forces re-approval. Verified behavior-identical via ast-test diff against pre-rewrite baseline.
## [2026-05-27T07:22:16.880Z]
Phase 6 type-bridge: updated resolveAspects return type from reviewer?: 'ast'|'llm' to reviewer?: AspectReviewerSpec to match the new required object-form reviewer field on AspectDef.
## [2026-05-28T08:51:16.315Z]
Extended resolveAspects to include the references field from AspectDef in its return type. Previously the function returned { id, description, content, reviewer } for each aspect but omitted references (the array of supporting file paths). Adding references to the return value makes it available to callers such as the dry-run path in approve.ts, which needs the paths in order to load reference file content for prompt preview. The omission was a gap introduced when references were added to AspectDef — this change closes it.
## [2026-05-28T10:07:18.365Z]
Fixed resolveAspects to include AST aspects in the returned list even when they have no content.md files. Previously, aspects without markdown artifacts were filtered out unconditionally, which excluded AST aspects (which use check.mjs instead of content.md). The fix checks reviewer.type: if the aspect is an AST reviewer, it bypasses the content-file guard. LLM aspects still require at least one markdown content file.
## [2026-05-28T12:36:48.629Z]
Wire aspect-status resolver into approve flow. The auto-approve short-circuit and the GC predicate now use hasNonDraftEffectiveAspects() instead of computeEffectiveAspects().size > 0. Nodes whose every effective aspect resolves to draft no longer require a baseline or log entry, and their stale baselines are GC-eligible — draft is dormant by design.
