## [2026-05-13T05:48:00.416Z]
Distinguish WhenPredicateInvalidError when loading architecture.

Why: Plan Task 1.7. Graph.architectureError changed from bare string to ArchitectureLoadError (string | { code; message }) so downstream validators can emit a 'when-predicate-invalid' error code instead of folding the failure into generic architecture-invalid.

How to apply: graph-loader catches WhenPredicateInvalidError and returns structured form; falls back to bare-string for all other errors so legacy consumers keep working. Plan Task 1.7.
