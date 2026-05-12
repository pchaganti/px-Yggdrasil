## [2026-05-12T10:49:07.334Z]
fix: log-integrity and log-format error codes were not displayed in Errors section of yg check output. Both codes were counted in error total but fell through all category filters (drift, cascade, structural, architecture, coverage, completeness). Added explicit Log: section in formatOutput to render them with full message.
