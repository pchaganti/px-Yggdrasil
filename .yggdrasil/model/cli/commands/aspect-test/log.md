## [2026-06-13T03:12:08.131Z]
Rule authors need to exercise a single rule against a node or files and read the reviewer's reasoning without recording anything, so this diagnostic runs either reviewer kind, previews the assembled prompt for the non-deterministic kind, and is guaranteed never to touch the committed verdict store.
## [2026-06-13T03:16:12.838Z]
Each error this diagnostic swallows — an unavailable provider, an unreadable subject file, a reviewer that throws mid-run — leaves a diagnostic trace rather than failing silently, so an author debugging a flaky rule run can see exactly which step degraded.
## [2026-06-13T03:19:19.986Z]
A reference file that cannot be read aborts the diagnostic with an actionable message and leaves a diagnostic trace of the underlying read error, and the reference path it reports is normalized to forward slashes so the output is stable across platforms.
## [2026-06-13T05:33:57.815Z]
A report handed to a pipe now drains fully before the process exits, so a long error list sent to a capturing consumer (an agent, a grep, or CI) is never truncated by the process terminating before the kernel buffer flushes. The full refusal reason for a rejected pair is now shown in the gate output rather than being abbreviated, so the reader sees the complete reason a verdict was refused.
## [2026-06-16T09:52:40.157Z]
Removed the per-provider secrets merge here: yg-secrets is now a general deep-merge overlay over yg-config applied once at config parse time, so the resolved tier already reflects any local override and no separate merge is needed at review time.
## [2026-06-19T19:18:52.103Z]
Surface the per-unit companion files in the aspect diagnostic so an author can preview, before paying for a review, exactly which paired file the reviewer will see for each unit. The dry run executes the resolver live but never calls the reviewer or writes the lock, and the ad-hoc file mode refuses a companion aspect because resolving a companion needs the graph relations that an ad-hoc file run does not provide.
## [2026-06-21T16:25:13.357Z]
The rule-preview command now resolves and shows the waived line ranges the real reviewer would receive, so previewing a model-judged rule reflects the same waivers as a billed run instead of diverging from it.
## [2026-06-29T20:48:23.438Z]
Classify deterministic runner errors in the aspect-test command. A check that throws, returns the wrong shape, is async, or reports a violation against a file it was not given is a structured, actionable aspect-author failure carrying its own what/why/next. The node-scoped path previously routed these through the generic unclassified-error handler, which both told the agent to file a CLI bug and leaked an internal error-code prefix; the ad-hoc file path already rendered them cleanly, so the two surfaces disagreed. The command now renders the structured message and exits non-zero for both surfaces, including under the run-twice determinism mode where either run may surface such an error.
