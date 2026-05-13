## [2026-05-13T05:34:38.083Z]
Initial creation: file-content-cache.ts.

Why: Plan Task 1.4. The file-when evaluator (Task 1.5) needs to test content regex against files matching path predicates. Reading the same file twice within a single validator run is wasteful, and naive reads against multi-MB files or binaries would dominate runtime. The cache memoizes by absolute path, classifies payloads as binary/too-large, and lets the evaluator emit a clear content-not-evaluable trace instead of stalling.

How to apply: SIZE_LIMIT_BYTES = 5MB, BINARY_PROBE_BYTES = 8KB (null-byte probe). FS read failures are reported via unreadable=true so the validator can emit file-unreadable rather than masking as content mismatch. Plan Task 1.4.
## [2026-05-13T05:38:36.240Z]
Extend FileContentResult with unreadableReason field.

Why: file-when-evaluator (Task 1.5) needs the underlying OS error message (e.g. ENOENT, EACCES) to attach to the EvaluationResult so the validator can render file-unreadable diagnostics with actionable detail. Task 1.4 returned a bare unreadable=true which lost that signal.

How to apply: stat/readFile catch blocks now capture err.message into unreadableReason. No behavior change for binary/tooLarge paths. Plan Task 1.5 (companion to evaluator).
