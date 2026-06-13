## [2026-06-13T03:12:08.131Z]
Rule authors need to exercise a single rule against a node or files and read the reviewer's reasoning without recording anything, so this diagnostic runs either reviewer kind, previews the assembled prompt for the non-deterministic kind, and is guaranteed never to touch the committed verdict store.
## [2026-06-13T03:16:12.838Z]
Each error this diagnostic swallows — an unavailable provider, an unreadable subject file, a reviewer that throws mid-run — leaves a diagnostic trace rather than failing silently, so an author debugging a flaky rule run can see exactly which step degraded.
## [2026-06-13T03:19:19.986Z]
A reference file that cannot be read aborts the diagnostic with an actionable message and leaves a diagnostic trace of the underlying read error, and the reference path it reports is normalized to forward slashes so the output is stable across platforms.
## [2026-06-13T05:33:57.815Z]
A report handed to a pipe now drains fully before the process exits, so a long error list sent to a capturing consumer (an agent, a grep, or CI) is never truncated by the process terminating before the kernel buffer flushes. The full refusal reason for a rejected pair is now shown in the gate output rather than being abbreviated, so the reader sees the complete reason a verdict was refused.
