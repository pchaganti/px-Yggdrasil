## [2026-05-15T17:44:12.867Z]
Phase 2: split from cli/ast — types, report aggregator, public API index. Type: ast-adapter.
## [2026-05-26T08:53:55.218Z]
Violation gains column field (0-based from node.startPosition.column). Additive — pre-rewrite aspects unaffected. Useful for messages pointing at characters within a line.
## [2026-05-26T09:48:17.057Z]
Export new API (walk, report, inFile, findComments, closest) as named exports while keeping legacy ast namespace. Legacy inFile shim: /pattern/ → regex, glob meta-chars → glob, else contains. Both APIs coexist until Task 28 deletes legacy after all 14 aspects migrated.
## [2026-05-26T10:52:12.815Z]
Mapping extended to absorb walk.ts, file-path.ts, find-comments.ts after deletion of helpers-syntactic and helpers-naming nodes. Public API surface now lives under one node.
## [2026-05-30T10:05:16.581Z]
The comment-finding helper can now be called with a source-file object directly, deriving the programming language from the file's extension. Previously it required an explicit language argument and raised an unrecognized-language error when handed the file object that rule scripts actually receive, which made the documented call form unusable in practice. An unknown extension now produces a clear, explicit error instead of a confusing one.
