## [2026-05-15T10:17:15.671Z]
Fix deterministic violation: replace toLocaleString() with direct number interpolation — locale-independent output
## [2026-05-15T13:42:55.515Z]
R0.1 Phase 2: populate messageData alongside message at each buildIssueMessage call site. Structured IssueMessage now carried in CheckIssue; message string computed from it for backward compat.
## [2026-05-15T13:45:43.238Z]
R0.1 Phase 3: cli/check.ts now reads messageData via msg() helper to render issue output; buildIssueMessage called at CLI layer. Fallback to .message for issues not yet migrated in Phase 4.
## [2026-05-15T14:17:01.394Z]
Drop deprecated message field and buildIssueMessage import: CheckIssue objects now set only messageData; buildIssueMessage import removed from core layer. R0.1 Phase 5.
## [2026-05-16T04:54:08.442Z]
Remove dead flow-related branches: layer === 'flows' check in describeUpstreamCause and flowMatch block in groupCascadeByCause — flow YAML is no longer tracked, so these paths are unreachable. Also remove 'flow: --flow' from flagMap in computeSuggestedNext.
## [2026-05-16T05:58:05.490Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T19:31:38.898Z]
Updated effective-aspects import path to core/graph/aspects following the file move.
