## [2026-05-13T05:43:44.566Z]
Add predicate-trace.ts renderer.

Why: Plan Task 1.6. The file-when evaluator emits a PredicateTrace tree; users need a human-readable rendering for error message NEXT blocks (spec §7). Tree shape mirrors the predicate structure so users can see which clause passed and which failed during type classification.

How to apply: pure renderer, no I/O. Recursively walks the trace and pushes lines with 4-space indent per nesting level. Marker is ✓ when result=true, ✗ when result=false. atom-path/atom-content add a 'matches' / 'does not match' verb and surface optional detail (binary, >5MB, file unreadable). exempt prints the auto-exempt reason. Plan Task 1.6.
## [2026-05-15T19:28:50.559Z]
Move IssueMessage type to model/validation, re-export from message-builder for backward compat; add eslint-plugin-boundaries to enforce §4.4 allowed_relations as file-level import constraints
## [2026-05-16T08:39:07.512Z]
Add posixPath() helper to context-file.ts and context-node.ts; normalize all file paths at output boundary — satisfies posix-paths-output aspect added via multiple flows
## [2026-05-16T17:37:14.559Z]
Added loadGraphOrAbort helper (cli-preamble.ts) to centralize the 'No .yggdrasil/ directory' error previously duplicated across 12 commands. The helper exits with a structured what/why/next message on ENOENT-shaped loader failures and rethrows other errors.
## [2026-05-16T18:22:21.557Z]
Added abortOnUnexpectedError helper to cli-preamble.ts. Generic catch-block errors across all commands now route through this single emit point, producing a uniform 'Unexpected error while <context>: <msg>' wrapped in buildIssueMessage.
## [2026-05-28T08:15:42.398Z]
Added optional references field (Array<{path, description?}>) to both NodeContextAspect and FileContextAspect interfaces. This field carries per-aspect reference paths through the data shape so the formatter can render additional 'read:' lines for each reference. The field is populated only for LLM aspects; AST aspects always produce undefined.
