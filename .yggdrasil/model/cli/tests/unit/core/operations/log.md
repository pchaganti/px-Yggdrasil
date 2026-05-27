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
