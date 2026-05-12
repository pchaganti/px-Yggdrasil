## [2026-05-12T11:01:18.102Z]
Add stderr warnings to find-index.ts for two cases spec required: filesystem error reading log.md (was debug-only), and log.md truncation >1MB (was silent). Both now emit buildIssueMessage-style warnings on stderr while continuing indexing.
