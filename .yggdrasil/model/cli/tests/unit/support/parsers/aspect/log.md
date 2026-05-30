## [2026-05-29T05:14:32.236Z]
Add test for structure reviewer type. New test verifies that parseAspect accepts 'structure' as a valid reviewer.type value in aspect YAML.
## [2026-05-29T05:30:03.380Z]
Add test for aspect-references-on-structure error: structure aspects with references should be rejected. Tests placement above the aspect-references-on-ast check to establish more-specific-first ordering.
## [2026-05-29T05:35:22.177Z]
Add test for aspect-structure-tier-not-allowed error: structure aspects with tier should be rejected. Tests placement before the aspect-ast-tier-not-allowed check to establish more-specific-first ordering.
## [2026-05-29T05:38:48.071Z]
Add tests for aspect-language-on-structure error: structure aspects with language should be rejected. Two near-duplicate tests ensure coverage of both the happy path and the specific placement-lock that detects language even when references is absent.
## [2026-05-29T22:52:41.938Z]
The aspect status-field parsing tests were switched from a single shared on-disk fixture directory to a fresh per-test temporary directory created under the operating system temp location, tracked and removed after each test. Under a parallel test runner the shared directory let one test's teardown delete fixtures another test was still reading, producing intermittent missing-file failures on otherwise-correct code. Isolating each test's fixtures removes the shared mutable state and the race. The motivation was concrete: overall branch coverage sits only marginally above the project gate, so a single spurious test failure could drop coverage under the threshold and block unrelated commits.
## [2026-05-30T14:09:02.534Z]
The per-aspect language declaration was removed from the system. An aspect that ships a parsed-tree check used to carry a `language:` list naming the languages it targeted, and the system validated that list with four dedicated checks. Nothing in the runtime ever read it: the engine already determines each source file's language from its file extension through one shared registry, then loads the matching grammar. The declaration was therefore inert metadata that could silently disagree with what the engine actually parsed — an authoritative-looking field that governed nothing.

This change deletes the field, the validators that policed its shape, and the documentation and tests that described it, and promotes the extension-to-grammar registry to the single authority for matching a file to its parser. The motivation is to remove a confusing mismatch between what an aspect claimed about languages and what the engine did, and to collapse the duplicated extension-knowledge that had drifted into more than one place.

The language a parsed-tree check sees for a given file is now derived solely from that file's extension; an unrecognized extension yields no parsed tree rather than a per-aspect error. The drift identity of a graph-aware structural check is deliberately held stable across this change so existing approvals are not invalidated by metadata that never affected behavior.
