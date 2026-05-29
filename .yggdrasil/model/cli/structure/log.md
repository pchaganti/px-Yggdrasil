## [2026-05-29T04:58:03.293Z]
Initial placeholder for the structure-aspect runtime entry point. The public subpath export and build wiring (tsup entry) are in place; concrete exports are populated as the feature is built incrementally. The node and structure-adapter type are introduced now to establish graph coverage and ensure the entry point is verifiable during development.
## [2026-05-29T05:07:42.841Z]
Added normalizeMappingPath and isPathInMapping for membership testing in collectAllowedReadsForAspect. These pure functions provide string-level mapping validation without filesystem I/O; concrete file enumeration happens later in the runner.
