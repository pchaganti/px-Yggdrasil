## [2026-05-13T05:28:56.818Z]
Add file-when.test.ts covering FileWhenPredicate and PredicateTrace type shapes.

Why: Task 1.2 introduces a new type module (cli/model/file-when); unit tests guard the union variants so accidental shape regressions surface at compile time.

How to apply: Tests do shape-only assertions (no runtime evaluator yet — that lands in Task 1.5). Plan Task 1.2.
