## [2026-05-12T10:49:07.334Z]
fix: log-integrity and log-format error codes were not displayed in Errors section of yg check output. Both codes were counted in error total but fell through all category filters (drift, cascade, structural, architecture, coverage, completeness). Added explicit Log: section in formatOutput to render them with full message.
## [2026-05-15T08:19:51.273Z]
Add strict coverage grouping in formatOutput: when >5 type-strict-orphan/misplaced/overlap errors, show grouped summary (count + 5 samples + '... (N more)'); expand STRUCTURAL_CODES to include all new when/enforce/type validation codes; add STRICT_CODES set and 'strict' category to result summary line.
