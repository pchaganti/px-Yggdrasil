## [2026-05-28T19:52:54.267Z]
Strip dangling design/plan section references from JSDoc and test descriptions. The design doc lives in .plans/ which is gitignored and will be deleted; references like 'spec §7', 'design §12.1', 'Task 14' become stale pointers to non-existent files. Replaced with self-contained prose. No behavior change.
