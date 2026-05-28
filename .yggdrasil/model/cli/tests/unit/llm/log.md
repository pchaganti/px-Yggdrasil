## [2026-05-26T08:07:23.902Z]
Update cli-base.test.ts assertions to include errorSource: 'codeViolation' in toEqual checks (parseAspectResponse now normalizes all returned objects to include errorSource). Add error-source.test.ts: behavioral tests for AspectResponse errorSource filter semantics.
## [2026-05-28T08:25:39.294Z]
Added unit tests for escapeXmlText helper covering: entity escaping order (& before < >), attribute vs body mode (" handling), preservation of tab/LF/CR, escaping of other control characters (U+0000..U+001F), and a round-trip integration case with a realistic aspect description string. All 7 tests pass.
## [2026-05-28T08:28:31.444Z]
Fixed determinism violation: replaced http://localhost:1 with http://localhost:99999 as the unreachable-endpoint stand-in in model-fetcher and reviewer-test tests. Port 1 (TCP multiplex) is a valid OS-level port that could be bound in some environments, making the test environment-dependent. Port 99999 exceeds the maximum valid port number (65535) and is always invalid regardless of machine state, making it a deterministic unreachable-endpoint signal consistent with how other test files in this suite handle the same pattern.
## [2026-05-28T08:35:55.675Z]
Added aspect-verifier-references.test.ts with 7 tests covering the new references parameter of buildPrompt: omits the <references> block when array is empty, emits it when non-empty with correct path/description attributes, preserves declared order, escapes XML in description attribute and content body, includes a yg-suppress notice in the references comment, and verifies block positioning (after <aspect>, before <source-files>). Added the new file to the node mapping.
## [2026-05-28T10:06:02.559Z]
Updated xml-escape test assertions for padded hex: &#x1; → &#x01;, &#x7; → &#x07;; &#x1f; is unchanged (already two digits). Tests now match the padStart(2, '0') behavior.
## [2026-05-28T10:18:49.162Z]
Fixed non-deterministic env-var dependency in resolveApiKey test suite: added beforeEach to delete process.env.OPENAI_API_KEY before each test, ensuring 'returns undefined when no key available' is not affected by ambient environment or by test ordering (beforeEach + afterEach sandwich removes any setup/teardown asymmetry). Updated xml-escape test assertions for padded hex encoding.
## [2026-05-28T10:37:57.993Z]
Updated aspect-verifier references test to assert ABSENCE of the suppress-related notices (MUST be ignored, NOT subject to review, Supporting files follow) following the design decision to remove the defensive yg-suppress notice from prompts.
