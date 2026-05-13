## [2026-05-13T05:28:56.718Z]
Initial creation: FileWhenPredicate + PredicateTrace + EvaluationResult types.

Why: 4.4.0 needs a per-file when predicate for node_type classification (path/content atoms + boolean operators) that is structurally separate from the aspect-level WhenPredicate (which uses graph-shape atoms). Sharing operator names but with distinct atoms requires a parallel type module.

How to apply: pulled out as its own types node parallel to cli/model/when. Plan Task 1.2.
