## [2026-05-16T13:59:47.325Z]
Update test fixtures to match updated Graph model types: nodeParseErrors entries now use messageData: IssueMessage instead of message: string; architectureError raw string replaced with structured { code, messageData } object.
## [2026-05-26T08:07:19.411Z]
Update aspect-verifier.test.ts: add errorSource: 'codeViolation' to mock provider responses and toEqual assertions. Required field change means all mock AspectResponse objects and assertions must include errorSource.
## [2026-05-27T07:22:46.460Z]
Phase 6 type-bridge: validator.test.ts, validator-aspect-files.test.ts, and validator-reviewer.test.ts updated — createAspect/makeAspect helpers now always include reviewer field with default { type: 'llm' }; string shorthand 'ast'/'llm' accepted via bridge; inline aspect literals updated to include reviewer.
## [2026-05-27T07:55:57.284Z]
Updated inline aspect fixture to include v5 reviewer field (reviewer: { type: llm }). Required because parseAspect now rejects aspects without reviewer.
## [2026-05-27T09:36:01.009Z]
Added Phase 9 validator tests: aspectParseErrors emission, config-reviewer-missing check (with and without configError), aspect-tier-unknown check (valid tier, missing tier, ast-type suppression, configError suppression).
## [2026-05-27T10:13:06.600Z]
Phase 9: rewrote validator-reviewer.test.ts to add tests for Tasks 36, 36b, 37, 37b, 38 — covering aspectParseErrors emission, config-reviewer-missing check, aspect-tier-unknown check, and secrets-non-credential-field check. Also added tests for missing rule-source combinations (LLM+only check.mjs, AST+only content.md) in validator-aspect-files.test.ts to cover previously uncovered branches.
## [2026-05-27T13:55:05.624Z]
Removed the test block that exercised the deleted reviewer-enum validator function. Reviewer shape is rejected at the parser layer; the validator no longer has structural responsibility for it.
## [2026-05-28T08:00:20.574Z]
Added validator-references.test.ts — four unit tests for the new aspect-reference-broken validation rule. Tests cover: (1) a missing reference file emits the error with the path in the what field; (2) a reference pointing at a directory emits the error; (3) a reference pointing at an existing regular file produces no error; (4) a reference pointing at a symlink that resolves to a regular file produces no error (confirming statPath follow-symlinks semantics). The test file was added to this node's mapping rather than creating a new node because these tests exercise the same validator pipeline as the existing validator test files in this node.
## [2026-05-28T08:06:31.692Z]
Added test coverage for the three new validator error codes introduced in checkAspectReferences: aspect-reference-too-large (per-file size limit), aspect-references-total-too-large (total bytes per aspect limit), and aspect-references-empty-array (warning for explicitly empty references list). Tests verify that per-tier size caps from the reviewer config are honored, that the default 64 KiB / 256 KiB caps apply when the tier omits the references field, and that the empty-array case produces a warning rather than an error.
