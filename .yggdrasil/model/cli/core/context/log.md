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
