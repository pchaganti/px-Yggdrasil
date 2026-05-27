## [2026-05-27T07:22:46.610Z]
Phase 6 type-bridge: config-parser.test.ts updated — all config.llm references replaced with getLlm(config) bridge function that extracts the first tier from the new ReviewerConfig.tiers structure.
## [2026-05-27T07:56:05.156Z]
Updated inline aspect YAML strings to use v5 reviewer format (reviewer: { type: llm } and reviewer: { type: ast, language: [typescript] }) instead of legacy string forms. Aspect without reviewer now gets aspect-reviewer-missing error and is excluded from graph.aspects.
