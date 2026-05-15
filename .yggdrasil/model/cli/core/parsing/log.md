## [2026-05-15T13:21:55.082Z]
Initial creation (R0.6): in-memory parsers (log-parser, file-when-parser, when-parser) moved from io/ to core/parsing/. These are pure computation modules — no file I/O — so they belong in core/ not io/. Replaces separate cli/file-when-support and cli/when-support nodes (deleted).
## [2026-05-15T13:26:16.740Z]
Fix relative model imports in moved files: file-when-parser.ts and when-parser.ts had '../model/...' imports (correct from io/) but now need '../../model/...' from core/parsing/. No logic change.
