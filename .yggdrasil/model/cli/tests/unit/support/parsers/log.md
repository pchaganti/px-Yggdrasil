## [2026-05-26T09:57:44.112Z]
Add test cases for language field on AspectDef: single-language array, multi-language array, and LLM aspect without language field.
## [2026-05-27T07:40:44.345Z]
Added three tests for object-form reviewer parsing: { type: ast }, { type: llm, tier: expensive }, and array-valued reviewer (invalid shape defaults to llm). Covers new AspectReviewerSpec object branches added to aspect-parser.ts in the v5 reviewer-tiers refactor.
## [2026-05-27T07:56:05.289Z]
Rewrote aspect-parser.test.ts to use the new ParseAspectResult discriminated union API. All old tests that expected parseAspect to throw now check r.ok === false and inspect r.errors. Added new describe blocks for v5 happy paths (AST, LLM no tier, LLM with tier) and v5 error paths (legacy string, missing reviewer, null reviewer, type-missing, type-invalid, AST+tier, unknown key, multi-error, empty mapping). Updated all inline YAML to include reviewer: { type: llm } since parseAspect now requires it.
