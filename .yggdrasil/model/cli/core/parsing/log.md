## [2026-05-15T13:21:55.082Z]
Initial creation (R0.6): in-memory parsers (log-parser, file-when-parser, when-parser) moved from io/ to core/parsing/. These are pure computation modules — no file I/O — so they belong in core/ not io/. Replaces separate cli/file-when-support and cli/when-support nodes (deleted).
## [2026-05-15T13:26:16.740Z]
Fix relative model imports in moved files: file-when-parser.ts and when-parser.ts had '../model/...' imports (correct from io/) but now need '../../model/...' from core/parsing/. No logic change.
## [2026-05-16T17:09:32.931Z]
Extracted shared parsePredicateBoolean helper into new predicate-boolean.ts. Both when-parser and file-when-parser now delegate to it (~50 LOC duplication eliminated). The helper is generic over the clause type and accepts an optional error class so file-when-parser preserves its WhenPredicateInvalidError contract. Error messages and dotted-path conventions are unchanged.
