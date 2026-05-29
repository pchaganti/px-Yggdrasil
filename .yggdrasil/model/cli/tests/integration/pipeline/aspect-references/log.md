## [2026-05-29T09:56:03.900Z]
aspect-references integration test updated to match the new check output format from the renderer refactor.
## [2026-05-29T09:57:06.536Z]
Updated hasDrift check in aspect-references-drift integration test. The old check searched for 'Cascade' and 'Drift' (capitalized section headers). The new format uses lowercase labels 'cascade (N)' and 'drift' in the error blocks, so the check was updated to use case-insensitive matching.
## [2026-05-29T10:07:14.310Z]
Aspect-references drift test updated to match the new grouped check output format. Drift detection now uses case-insensitive substring matches for 'cascade' and 'drift'.
