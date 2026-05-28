## [2026-05-13T05:35:40.794Z]
Add file-content-cache.test.ts mapping.

Why: Task 1.4 introduces FileContentCache; the unit tests need a home and the operations test node already covers core unit tests broadly. Avoids creating yet another single-file test node.

How to apply: Mapping extended; description updated to mention file-content-cache.
## [2026-05-15T08:33:46.128Z]
Add type-classifier.test.ts to operations test node: 10 tests covering classifyFile, satisfied-fraction algorithm (all_of average, any_of max, not invert, exempt, empty cases), and closest-3 limiting.
## [2026-05-26T08:07:15.670Z]
Update approve-llm.test.ts mocks: add required errorSource discriminator to all AspectResponse mock return values. providerError: true mock replaced with errorSource: 'provider'; satisfied mocks use errorSource: 'codeViolation'.
## [2026-05-26T08:42:27.088Z]
Updated approve-llm.test.ts to check for 'infrastructure failed' in refuseReasonData.what following the rename of the provider-failure refuse message from 'Reviewer provider failed' to 'Reviewer infrastructure failed'. Test intent unchanged: verifies that LLM provider errors cause approve to refuse with a non-code-issue message.
## [2026-05-27T07:22:46.309Z]
Phase 6 type-bridge: effective-aspects.test.ts and impact.test.ts aspect literals updated to include reviewer: { type: 'llm' as const } as required by AspectDef.
## [2026-05-27T07:55:57.165Z]
Updated TEST_ASPECT and all inline aspect YAML strings to use v5 reviewer format (reviewer: { type: llm }) instead of no reviewer field. Required because parseAspect now returns aspect-reviewer-missing for aspects without reviewer, which would exclude them from graph.aspects and break drift/approve/check tests that depend on aspects being loaded.
## [2026-05-27T08:37:06.302Z]
Fixed non-deterministic order assertions in impact.test.ts that were flagged by the test-deterministic aspect reviewer. Three assertions that used toEqual on potentially unordered arrays now sort before comparing: collectReverseDependents result.direct (diamond-dependency test), and two collectIndirectDependents result.indirectPaths assertions. The toEqual-without-sort pattern was already inconsistent with the file (line 149 used explicit sort).
## [2026-05-27T11:11:33.534Z]
Updated unit tests for approve orchestration to match the new v5 reviewer API: runApproveWithReviewer now takes a secretsByProvider map instead of a pre-built provider, and runLlmVerification now takes a Map for session-scoped secrets. Tests mock createLlmProvider from the LLM registry and supply a test-controlled provider through the mock, so tests remain isolated from real provider infrastructure. The reviewer config fixture uses a non-reserved tier name (the name 'default' is reserved by the config parser).
## [2026-05-27T11:39:50.631Z]
Extended approve-llm.test.ts with tests for resolveExecutionPlan, per-tier batching paths (AST pass, AST fail, AST runtime error, provider unavailable, plan errors) to cover new code paths added during v5 reviewer-tiers implementation.
## [2026-05-28T08:42:07.738Z]
Added approve-reviewer-references.test.ts with 5 unit tests covering the loadAndIsolateReferences helper: success path with content retrieval, cross-call cache deduplication, UTF-8 BOM stripping, failure isolation when a reference file cannot be read (returns LLM_REFERENCE_UNREADABLE reason, does not throw), and the empty-references fast path.
