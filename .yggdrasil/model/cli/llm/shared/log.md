## [2026-05-15T17:44:39.833Z]
Phase 2: created from files in old cli/llm (parent mapping) and cli/llm/verification. Type: llm-shared. Consolidates types, provider registry, api-utils, aspect verifier, model fetcher, reviewer test.
## [2026-05-15T18:32:03.036Z]
Fix LLM reviewer prompt: add bracket form (yg-suppress-disable/enable) instruction so LLM reviewer honors it the same as single-line form
## [2026-05-16T06:58:02.290Z]
Add optional timeoutMs parameter to apiFetch() — ollama health-check calls need 5s timeout vs the 60s default for LLM inference.
## [2026-05-26T08:03:00.097Z]
Rename providerError boolean to required errorSource discriminator on AspectResponse. Three explicit values: codeViolation, provider, astRuntime. Forces exhaustive matching — adding a fourth tag later fails typecheck instead of silently slipping past filters. aspect-verifier and types both touched.
## [2026-05-26T08:24:43.055Z]
Fix two errorSource propagation bugs in aspect-verifier.ts: (1) verifyWithConsensus was hardcoding codeViolation on all failing votes; now propagates 'provider' when all losing votes carry errorSource: 'provider'. (2) early-return no-source-files path now includes errorSource: 'codeViolation' for consistency with Task 3 making the field required on AspectVerificationResult.
## [2026-05-28T08:25:35.202Z]
Added escapeXmlText utility for safe XML embedding of aspect descriptions and content in reviewer prompts. The helper escapes the five XML-significant characters (& < > " and control chars U+0000..U+001F except tab/LF/CR). Pure function with no side effects, no I/O. Introduced to support the upcoming buildPrompt function that embeds aspect references in structured XML blocks sent to LLM reviewers.
## [2026-05-28T08:35:50.463Z]
Extended buildPrompt to accept an optional references array (5th parameter, default []). When non-empty, a <references> XML block is emitted between </aspect> and <source-files>, with each entry's path and optional description XML-attribute-escaped via escapeXmlText, and content body also escaped. A conditional notice inside the references block instructs the reviewer that yg-suppress markers inside references MUST be ignored. Updated VerifyAspectsParams to carry per-aspect references arrays, and updated the verifyAspects chunk loop to forward aspect.references ?? [] to buildPrompt. Existing 4-arg callers compile without changes because the 5th param defaults to []. Escaping uses the escapeXmlText utility added in the previous task.
