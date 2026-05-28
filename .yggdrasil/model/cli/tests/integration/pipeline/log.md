## [2026-05-26T10:10:03.854Z]
Add integration test coverage for aspect language validation: tests for missing-language (AST), scalar-not-array, empty-list, unknown-language, valid language (no errors), and LLM aspect with unknown language.
## [2026-05-27T07:55:50.989Z]
Updated all fixture YAML strings to use v5 reviewer format (reviewer: { type: ast } or reviewer: { type: llm }) instead of legacy string forms. This is required because parseAspect no longer silently accepts string reviewer values; they now produce structured errors and the aspects are excluded from graph.aspects.
## [2026-05-27T08:14:57.558Z]
Added reviewer: { type: llm } to the inline aspect fixture in the context-pipeline integration test. Required because parseAspect now returns aspect-reviewer-missing for aspects without reviewer, causing the built CLI to return exit 1 when the aspect is referenced in a node's aspects list but isn't loaded into graph.aspects.
## [2026-05-27T09:47:43.184Z]
Updated gitignore-count integration test fixture: added v5 reviewer config (reviewer.tiers.default-tier with claude-code provider) to yg-config.yaml so config-reviewer-missing validation error does not block the context command. The test fixture previously omitted reviewer config, which was valid in v4 but is now required in v5.
## [2026-05-28T08:51:20.914Z]
Added integration test verify that yg approve --dry-run includes the <references> block in prompt preview output when the aspect declares references. The test spins up a minimal repo with an LLM aspect that references a docs file, runs approve --dry-run via execFileSync, and asserts the output contains the <references> XML tag, the reference path, and the file content.
