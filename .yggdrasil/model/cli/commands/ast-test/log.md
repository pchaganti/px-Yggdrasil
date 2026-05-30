## [2026-05-15T09:51:42.481Z]
Fix no-explicit-any ESLint warning: catch (e: any) → catch (e: unknown) with explicit cast
## [2026-05-15T17:52:30.885Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that exits without re-throwing.
## [2026-05-16T05:58:00.894Z]
Phase 4.7 (no-direct-fs): update hash and paths imports from utils/ to io/ following move of these modules to persistence-adapter layer
## [2026-05-16T17:37:13.303Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.033Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-27T07:22:10.583Z]
Phase 6 type-bridge: updated reviewer comparison from aspect.reviewer !== 'ast' to aspect.reviewer.type !== 'ast' and reviewer display from aspect.reviewer ?? 'llm' to aspect.reviewer.type to match AspectReviewerSpec object shape.
## [2026-05-30T18:08:08.625Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
