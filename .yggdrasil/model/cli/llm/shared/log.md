## [2026-05-15T17:44:39.833Z]
Phase 2: created from files in old cli/llm (parent mapping) and cli/llm/verification. Type: llm-shared. Consolidates types, provider registry, api-utils, aspect verifier, model fetcher, reviewer test.
## [2026-05-15T18:32:03.036Z]
Fix LLM reviewer prompt: add bracket form (yg-suppress-disable/enable) instruction so LLM reviewer honors it the same as single-line form
## [2026-05-16T06:58:02.290Z]
Add optional timeoutMs parameter to apiFetch() — ollama health-check calls need 5s timeout vs the 60s default for LLM inference.
## [2026-05-26T08:03:00.097Z]
Rename providerError boolean to required errorSource discriminator on AspectResponse. Three explicit values: codeViolation, provider, astRuntime. Forces exhaustive matching — adding a fourth tag later fails typecheck instead of silently slipping past filters. aspect-verifier and types both touched.
