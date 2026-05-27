## [2026-05-16T13:42:18.151Z]
Rename migration-4.3-to-4.4.test.ts → migration-4.2-to-4.3.test.ts. Part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
## [2026-05-27T07:55:50.864Z]
Updated the richGraph() test fixture to use v5 reviewer format for the audit-logging aspect (reviewer: { type: llm }) instead of no reviewer field. Required because parseAspect now returns aspect-reviewer-missing for aspects without reviewer, which would prevent the aspect from loading into graph.aspects.
