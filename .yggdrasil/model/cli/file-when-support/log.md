## [2026-05-13T05:31:51.259Z]
Initial creation: file-when-parser.ts.

Why: Plan Task 1.3 introduces a per-file when predicate (path/content atoms + all_of/any_of/not operators) that must be parsed from architecture YAML. The sub-parser is pure (no disk I/O) and consumes already-parsed YAML values, exactly like cli/when-support — but for a distinct predicate grammar (file-level vs aspect-level).

How to apply: New node parallel to cli/when-support. Type engine, no aspects (matches sibling). Validates regex syntax at parse time; throws WhenPredicateInvalidError that downstream architecture-parser will translate to error code when-predicate-invalid. Plan Task 1.3.
