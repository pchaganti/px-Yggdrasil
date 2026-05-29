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
