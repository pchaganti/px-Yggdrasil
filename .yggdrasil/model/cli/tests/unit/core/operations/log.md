## [2026-05-13T05:35:40.794Z]
Add file-content-cache.test.ts mapping.

Why: Task 1.4 introduces FileContentCache; the unit tests need a home and the operations test node already covers core unit tests broadly. Avoids creating yet another single-file test node.

How to apply: Mapping extended; description updated to mention file-content-cache.
## [2026-05-15T08:33:46.128Z]
Add type-classifier.test.ts to operations test node: 10 tests covering classifyFile, satisfied-fraction algorithm (all_of average, any_of max, not invert, exempt, empty cases), and closest-3 limiting.
