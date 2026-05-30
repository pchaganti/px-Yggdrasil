## [2026-05-16T04:34:06.578Z]
Remove yg-flow.yaml from tracked file set — flow aspect propagation is captured through aspect files (channel 3/5), making flow YAML tracking redundant. Tracking it caused false upstream drift on description-only flow changes.
## [2026-05-16T05:58:05.607Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T19:18:57.526Z]
Removed local definitions of collectAncestors, collectParticipatingFlows, collectDependencyAncestors, and DependencyAncestorInfo from context-builder.ts. They now live in core/graph/. A re-export shim preserves the public import path for legacy callers (effective-aspects, context-files, impact, build-context) until a follow-up sweep migrates them.
## [2026-05-16T19:22:30.029Z]
Fixed posix-paths-output gap in buildFileContextData: filePath parameter is now normalized via .replace(/\\/g, '/').replace(/\/+\$/, '') before being stored in FileContextData. Reviewer flagged this as a pre-existing issue surfaced by cascade re-approval.
## [2026-05-16T19:25:23.741Z]
Removed unused FlowDef type import after the local collectParticipatingFlows definition was moved to core/graph/flows.ts.
## [2026-05-16T19:27:24.119Z]
Removed trailing slash from buildHierarchyLayer 'Module Context (path/)' label. The slash was a visual hint for directory but posix-paths-output prohibits stored trailing slashes in graph output values. Label still reads naturally.
## [2026-05-16T19:31:39.022Z]
Updated effective-aspects import path to core/graph/aspects following the file move.
## [2026-05-16T19:44:31.850Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-27T07:22:17.127Z]
Phase 6 type-bridge: updated reviewer comparison from aspectDef?.reviewer === 'ast' to aspectDef?.reviewer?.type === 'ast' in both buildNodeContextData and buildFileContextData to match AspectReviewerSpec object shape.
## [2026-05-27T07:26:19.732Z]
posix-paths-output fix: buildNodeContextData now normalizes the caller-supplied nodePath before returning it as path in NodeContextData; buildFileContextData now normalizes ownerPath before returning it in FileContextData. Both fixes apply replace(backslash, slash) + trailing-slash strip, matching the existing normalization applied to filePath in that same function.
## [2026-05-28T08:15:37.722Z]
Extended both aspects.map() blocks in context-builder.ts to compute and attach optional references field to each aspect entry. For LLM aspects with non-empty references arrays, the refs are mapped to {path, description} objects and spread onto the returned entry. AST aspects and LLM aspects with empty references produce undefined (field omitted). This plumbing makes reference data available downstream for the formatter (context-node and context-file) to render 'read:' lines per reference.
## [2026-05-28T14:01:45.108Z]
Populate effective aspect status on aspect entries returned by buildNodeContextData and buildFileContextData. Each aspect entry now carries the effective status as resolved by computeEffectiveAspectStatuses on the owner node, falling back to the aspect-default and finally to enforced. Downstream formatters consume this to surface enforcement posture next to aspect entries.
## [2026-05-30T18:08:09.608Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
