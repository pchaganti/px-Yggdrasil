## [2026-05-26T09:51:17.137Z]
Add test for AST_CHECK_FILE_NOT_IN_CONTEXT guard — verifies that check.mjs cannot return violations referencing files outside ctx.files.
## [2026-05-27T07:22:38.541Z]
Phase 6 type-bridge: updated aspect literals to use reviewer: { type: 'ast' as const } / reviewer: { type: 'llm' as const } object form; updated reviewer comparison from a.reviewer !== 'ast' to a.reviewer.type !== 'ast'; updated reviewer value assertion from .reviewer to .reviewer.type.
## [2026-05-27T07:55:50.735Z]
Updated setupProject() and the broken-aspect fixture to use v5 reviewer format (reviewer: { type: ast, language: [typescript] }) instead of the legacy string (reviewer: ast). This aligns the test setup with the new parseAspect contract that rejects legacy string forms and requires a mapping with type.
## [2026-05-28T10:07:25.741Z]
Added integration test for parseCache: verifies the same file is parsed only once across two aspect calls when a shared cache is provided. The test modifies the file to invalid syntax between calls — the second call succeeds because the cache is consulted and returns the previously-parsed AST, proving the cache is actually used. Cache size stays at 1 across both calls.
