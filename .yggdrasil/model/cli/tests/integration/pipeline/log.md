## [2026-05-26T10:10:03.854Z]
Add integration test coverage for aspect language validation: tests for missing-language (AST), scalar-not-array, empty-list, unknown-language, valid language (no errors), and LLM aspect with unknown language.
## [2026-05-27T07:55:50.989Z]
Updated all fixture YAML strings to use v5 reviewer format (reviewer: { type: ast } or reviewer: { type: llm }) instead of legacy string forms. This is required because parseAspect no longer silently accepts string reviewer values; they now produce structured errors and the aspects are excluded from graph.aspects.
## [2026-05-27T08:14:57.558Z]
Added reviewer: { type: llm } to the inline aspect fixture in the context-pipeline integration test. Required because parseAspect now returns aspect-reviewer-missing for aspects without reviewer, causing the built CLI to return exit 1 when the aspect is referenced in a node's aspects list but isn't loaded into graph.aspects.
