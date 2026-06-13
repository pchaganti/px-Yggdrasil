## [2026-06-13T03:12:08.131Z]
Rule authors need to exercise a single rule against a node or files and read the reviewer's reasoning without recording anything, so this diagnostic runs either reviewer kind, previews the assembled prompt for the non-deterministic kind, and is guaranteed never to touch the committed verdict store.
## [2026-06-13T03:16:12.838Z]
Each error this diagnostic swallows — an unavailable provider, an unreadable subject file, a reviewer that throws mid-run — leaves a diagnostic trace rather than failing silently, so an author debugging a flaky rule run can see exactly which step degraded.
## [2026-06-13T03:19:19.986Z]
A reference file that cannot be read aborts the diagnostic with an actionable message and leaves a diagnostic trace of the underlying read error, and the reference path it reports is normalized to forward slashes so the output is stable across platforms.
