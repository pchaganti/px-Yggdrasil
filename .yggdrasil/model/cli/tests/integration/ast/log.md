## [2026-05-26T09:51:17.137Z]
Add test for AST_CHECK_FILE_NOT_IN_CONTEXT guard — verifies that check.mjs cannot return violations referencing files outside ctx.files.
## [2026-05-27T07:22:38.541Z]
Phase 6 type-bridge: updated aspect literals to use reviewer: { type: 'ast' as const } / reviewer: { type: 'llm' as const } object form; updated reviewer comparison from a.reviewer !== 'ast' to a.reviewer.type !== 'ast'; updated reviewer value assertion from .reviewer to .reviewer.type.
