## [2026-05-26T09:51:17.137Z]
Add test for AST_CHECK_FILE_NOT_IN_CONTEXT guard — verifies that check.mjs cannot return violations referencing files outside ctx.files.
## [2026-05-27T07:22:38.541Z]
Phase 6 type-bridge: updated aspect literals to use reviewer: { type: 'ast' as const } / reviewer: { type: 'llm' as const } object form; updated reviewer comparison from a.reviewer !== 'ast' to a.reviewer.type !== 'ast'; updated reviewer value assertion from .reviewer to .reviewer.type.
## [2026-05-27T07:55:50.735Z]
Updated setupProject() and the broken-aspect fixture to use v5 reviewer format (reviewer: { type: ast, language: [typescript] }) instead of the legacy string (reviewer: ast). This aligns the test setup with the new parseAspect contract that rejects legacy string forms and requires a mapping with type.
## [2026-05-28T10:07:25.741Z]
Added integration test for parseCache: verifies the same file is parsed only once across two aspect calls when a shared cache is provided. The test modifies the file to invalid syntax between calls — the second call succeeds because the cache is consulted and returns the previously-parsed AST, proving the cache is actually used. Cache size stays at 1 across both calls.
## [2026-05-30T18:08:10.613Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
