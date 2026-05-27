## [2026-05-27T07:22:46.610Z]
Phase 6 type-bridge: config-parser.test.ts updated — all config.llm references replaced with getLlm(config) bridge function that extracts the first tier from the new ReviewerConfig.tiers structure.
## [2026-05-27T07:56:05.156Z]
Updated inline aspect YAML strings to use v5 reviewer format (reviewer: { type: llm } and reviewer: { type: ast, language: [typescript] }) instead of legacy string forms. Aspect without reviewer now gets aspect-reviewer-missing error and is excluded from graph.aspects.
## [2026-05-27T09:08:39.174Z]
Updated config-parser tests for the v5 reviewer format migration. The existing v4 happy-path tests were updated to expect ConfigParseError with appropriate legacy-format codes, since v4 configs are now rejected. Added a new describe block for v5 happy-path tests (minimal tier, multiple tiers with default, temperature and max_tokens, provider model defaults). Added a new describe block for v5 error-code tests covering all 17 structured error codes that parseReviewerV5 and parseTier can emit.
## [2026-05-27T09:23:39.958Z]
Added two config-parser tests verifying max_tokens validation: zero value and string value both throw config-tier-config-invalid.
## [2026-05-27T09:36:05.362Z]
Updated secrets-parser tests for v5 narrowing: non-api_key fields (model, temperature, max_tokens, provider, endpoint, consensus) are no longer extracted by loadSecrets and no longer cause validation errors at the loadSecrets layer. Added inspectSecretsForValidation tests covering clean file, foreign-key detection, and missing file.
## [2026-05-27T10:13:11.950Z]
Phase 9 Task 37b: updated secrets-parser.test.ts to reflect narrowed extractSecretFields — now only api_key is extracted from yg-secrets.yaml; other fields (model, temperature, consensus, max_tokens, provider, endpoint) are silently ignored. Added inspectSecretsForValidation import and describe block with 3 tests. Updated afterEach cleanup to also remove tmp-inspect-* dirs.
