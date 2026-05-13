## [2026-05-12T11:01:18.102Z]
Add stderr warnings to find-index.ts for two cases spec required: filesystem error reading log.md (was debug-only), and log.md truncation >1MB (was silent). Both now emit buildIssueMessage-style warnings on stderr while continuing indexing.
## [2026-05-13T05:19:31.112Z]
Accept empty/commented yg-architecture.yaml in parseArchitecture.

Why: 4.4.0 needs yg init to ship a placeholder architecture (commented-only example) and greenfield repos must pass yg check before any node_types are defined. Design §10 L1405 explicitly allows 'pusta lub tylko komentarze'.

How: top-level null/undefined raw and null/undefined node_types now fall back to empty {}. Non-mapping top-level shapes (arrays, scalars) still rejected with descriptive error. Plan Task 1.1.
