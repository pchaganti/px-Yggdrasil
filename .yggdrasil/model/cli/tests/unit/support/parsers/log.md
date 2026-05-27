## [2026-05-26T09:57:44.112Z]
Add test cases for language field on AspectDef: single-language array, multi-language array, and LLM aspect without language field.
## [2026-05-27T07:40:44.345Z]
Added three tests for object-form reviewer parsing: { type: ast }, { type: llm, tier: expensive }, and array-valued reviewer (invalid shape defaults to llm). Covers new AspectReviewerSpec object branches added to aspect-parser.ts in the v5 reviewer-tiers refactor.
