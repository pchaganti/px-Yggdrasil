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
