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
## [2026-05-28T10:05:41.526Z]
Padded control-character hex escape sequences to minimum two digits: code.toString(16).padStart(2, '0'). Previously U+0001 was emitted as &#x1; — now &#x01;. This matches standard XML numeric character reference conventions for single-digit hex values below 0x10. Characters at 0x10 and above (e.g. U+001F = &#x1f;) are unaffected — they already produce two hex digits.
## [2026-05-28T10:37:57.849Z]
Removed the defensive yg-suppress notice that previously appeared as an XML comment above the <references> block. References are pure context for the LLM reviewer — the reviewer's instructions already restrict it to verifying <source-files>, so suppression markers inside reference content have no effect by construction. The notice added prompt overhead with no behavioral benefit.
## [2026-05-29T10:09:44.452Z]
Re-approving after drift state was wiped during concurrent development session. No source changes — this approval records the baseline verdicts for newly-active aspects.
## [2026-05-29T10:10:06.733Z]
Re-approving all aspects because the what-why-next aspect content was updated (clarified that structured messageData field access in CLI renderers satisfies the rule, not just direct buildIssueMessage calls). The aspect content change triggered a cascade drift requiring full re-approval to establish verdicts for all active aspects.
## [2026-05-30T20:06:10.575Z]
The way a rule's verification is declared collapsed from three kinds — a human-language reviewer, a single-file programmable check, and a graph-aware programmable check — down to two: the human-language reviewer and one unified deterministic programmable check. The two programmable kinds were never a real choice, since the graph-aware kind is a superset of the single-file one; keeping both forced authors into a false up-front decision and made the tooling carry two parallel surfaces for one concept. Collapsing them removes that false choice. This change consolidates the remaining user-facing surface that still exposed the old split.

Specific to this node: a persisted per-verdict error-source token carrying the historical kind name is documented as retained for baseline compatibility rather than renamed, for the same reason — renaming a serialized token breaks every stored baseline.
## [2026-05-30T21:54:03.933Z]
Internal names that still referred to the retired single-file and graph-aware reviewer kinds were renamed to reflect the one unified deterministic kind: the per-aspect record of which files a deterministic check read, the synthetic drift-identity key summarising that set, the tracking layer those cross-node files sit on, and the error tag for a crash inside a non-reviewer (deterministic) runner. This is a clarity-only rename with no behaviour change — the verification mechanics, drift detection, and carry-forward are identical; only the identifiers and the persisted token strings changed so the code no longer speaks of reviewer kinds that no longer exist. Baselines were migrated in place to the new token names.
