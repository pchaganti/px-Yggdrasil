## [2026-05-15T10:17:15.671Z]
Fix deterministic violation: replace toLocaleString() with direct number interpolation — locale-independent output
## [2026-05-15T13:42:55.515Z]
R0.1 Phase 2: populate messageData alongside message at each buildIssueMessage call site. Structured IssueMessage now carried in CheckIssue; message string computed from it for backward compat.
## [2026-05-15T13:45:43.238Z]
R0.1 Phase 3: cli/check.ts now reads messageData via msg() helper to render issue output; buildIssueMessage called at CLI layer. Fallback to .message for issues not yet migrated in Phase 4.
## [2026-05-15T14:17:01.394Z]
Drop deprecated message field and buildIssueMessage import: CheckIssue objects now set only messageData; buildIssueMessage import removed from core layer. R0.1 Phase 5.
