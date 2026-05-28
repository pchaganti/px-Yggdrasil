## [2026-05-15T13:00:15.734Z]
Initial creation: split from cli/io parent (wide-node false positive blocked silent-missing-files approve with 14 files). Parsers child contains 8 parser files; inherits yaml-parser-contract, silent-missing-files, diagnostic-logging from parent via channel 2. log-parser.ts stays here temporarily until R0.6 moves it to core/parsing.
## [2026-05-15T13:09:48.512Z]
Aspect restructuring: removed silent-missing-files from parent inheritance (parent cli/io now has no aspects). Parsers explicitly declares yaml-parser-contract + diagnostic-logging only. silent-missing-files is irrelevant to parsers since they do not read optional resources — they either parse required files or throw. secrets-parser.ts handles optional yg-secrets.yaml but is itself a parser not a store; yaml-parser-contract + diagnostic-logging are the correct effective aspects for this child.
## [2026-05-15T13:21:54.979Z]
R0.6: update when-parser and file-when-parser imports — architecture-parser.ts, flow-parser.ts, node-parser.ts now import from ../core/parsing/ (files moved from io/). log-parser.ts removed from this node mapping (now owned by cli/core/parsing).
## [2026-05-15T13:26:16.840Z]
R0.6: fix aspect-parser.ts import — when-parser moved to core/parsing/ so import updated from './when-parser.js' to '../core/parsing/when-parser.js'. No logic change.
## [2026-05-15T13:34:06.614Z]
R0.8: add header comment to secrets-parser.ts clarifying its parser-adapter role — reads yg-secrets.yaml from disk (hence io/), yields structured config fragment.
## [2026-05-15T17:52:31.581Z]
Fix yaml-parser-contract violation: add Array.isArray() guard to schema-parser.ts type check.
## [2026-05-16T17:27:12.596Z]
Added Array.isArray(raw) to top-level shape guards in flow-parser, node-parser, and aspect-parser. Reason: typeof [] === 'object' means a YAML array document silently passed the previous typeof-only check, then failed later at the first property access with a confusing error. The new condition rejects arrays at the same site as null/non-object. schema-parser and architecture-parser already had Array.isArray and are unchanged. Wording of each error message is preserved so existing tests are unaffected.
## [2026-05-26T09:56:16.542Z]
Parser reads optional language array field from yg-aspect.yaml. Permissive — validation (required-for-AST, registry membership) is core/validator.ts.
## [2026-05-26T10:28:57.515Z]
Rewrote aspect parser-yaml-guard against raw tree-sitter API. Replaced string-based ast.inFile() with inFile({glob:...}) object form. No walk() needed — the check is pure text-regex on file content. Verified behavior-identical via ast-test diff.
## [2026-05-27T07:22:31.453Z]
Phase 6 type-bridge: aspect-parser.ts now returns AspectReviewerSpec object (required) instead of optional string; config-parser.ts now returns YggConfig.reviewer (ReviewerConfig) instead of YggConfig.llm (LlmConfig), wrapping the parsed LlmConfig in a tiers bridge for v5 compatibility.
## [2026-05-27T07:55:42.062Z]
Rewrote parseAspect to return ParseAspectResult (discriminated union {ok: true; aspect} | {ok: false; aspectId; errors}) instead of throwing on invalid reviewer shapes. The new parseReviewer helper collects errors independently: structural errors (missing/null reviewer, legacy string form, non-mapping) return immediately; within a mapping, type-missing and unknown-key checks are collected together before cross-field checks. Error codes: aspect-reviewer-missing, aspect-reviewer-legacy-string, aspect-reviewer-not-mapping, aspect-reviewer-type-missing, aspect-reviewer-type-invalid, aspect-ast-tier-not-allowed, aspect-reviewer-unknown-key, aspect-reviewer-tier-invalid. Legacy string form (reviewer: llm) is no longer silently converted — it returns a structured error with a migration hint pointing to yg init --upgrade.
## [2026-05-27T08:45:10.965Z]
Removed unused aspectYamlPath parameter from the internal parseReviewer helper. The parameter was declared but never used in error messages (all messages used aspectId). ESLint no-unused-vars flagged it. The function signature is unchanged externally.
## [2026-05-27T09:08:39.047Z]
Rewrote config-parser.ts to support the v5 reviewer.tiers structure. The v4 parseReviewerSection/normalizeProviderConfig functions were removed and replaced with parseReviewerV5 and parseTier. All v4 reviewer shapes now throw ConfigParseError (a structured error class) with specific codes: config-reviewer-legacy-format, config-reviewer-mixed-format, config-tiers-missing, config-tiers-empty, config-default-tier-missing, config-default-tier-unknown, config-tier-provider-missing, config-tier-provider-unknown, config-tier-config-missing, config-tier-config-not-mapping, config-tier-consensus-invalid, config-tier-name-invalid, config-tier-name-reserved, config-reviewer-unknown-key, config-tier-unknown-key.
## [2026-05-27T09:23:38.831Z]
Added max_tokens validation in parseTier: must be 'auto' or a positive number. This restores validation that existed in the v4 normalizeProviderConfig function but was omitted when rewriting to v5 parseTier.
## [2026-05-27T09:35:57.533Z]
Narrowed extractSecretFields to api_key only: v5 secrets file accepts only credentials, all non-credential fields (model, temperature, consensus, max_tokens, endpoint, provider) belong in yg-config.yaml reviewer tiers. Added inspectSecretsForValidation for the validator to detect and report non-credential fields as secrets-non-credential-field errors.
## [2026-05-27T13:54:50.205Z]
Replaced raw Error throws in the config parser with ConfigParseError so empty YAML and invalid parallel values surface through the structured-error channel instead of escaping the loader. Inline format-detection predicates removed; both parsers now import from the shared detector. The aspect parser rewords its messages to describe the current required shape without naming a specific schema version. Provider list import path updated to the leaf module to break the prior circular-import workaround.
## [2026-05-28T06:03:27.775Z]
KNOWN_PROVIDERS now imported from utils and re-exported from this module unchanged. The constant moved because io was not a natural home for a pure constant; utils covers it via the existing architecture entry.
