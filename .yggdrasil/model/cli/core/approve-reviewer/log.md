## [2026-05-15T15:49:31.286Z]
R0.2: new engine module — LLM verification orchestration extracted from cli/approve.ts. Runs verifyAspects on non-AST aspects, classifies provider vs code violations, commits drift state on pass. Avoids adding network-calling code to cli/core/approve which has the deterministic aspect.
