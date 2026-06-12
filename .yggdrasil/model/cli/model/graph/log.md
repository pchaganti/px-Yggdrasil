## [2026-05-26T09:56:17.832Z]
Extend AspectDef with optional language?: string[]. Required for AST aspects via validator; optional for LLM with registry-membership check.
## [2026-05-31T21:54:18.246Z]
Updated doc-comments to remove references to aspect-reviewer-legacy-string and the legacy-format concept from aspectParseErrors and configErrorCode doc strings. These comments described runtime behavior that was removed when legacy detection was relocated to migration-only; keeping them would mislead future maintainers about what codes are still produced.
## [2026-06-12T11:56:45.441Z]
Added ScopeDef interface (per: 'node' | 'file', optional files: FileWhenPredicate) placed near AspectDef. This is the canonical type for the review scope of an aspect, specifying whether verification covers the whole node or individual files within it, and optionally which files fall in scope. FileWhenPredicate was already imported; only the exported interface is new — no existing code was modified.
