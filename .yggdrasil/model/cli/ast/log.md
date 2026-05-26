## [2026-05-26T10:52:08.726Z]
Delete legacy helpers (call, casing, decorators, exports, imports, jsx, modifiers, name) and within() from walk.ts. ast/index.ts simplified to named exports only. Helpers-syntactic and helpers-naming nodes deleted. Walk, file-path, find-comments files joined cli/ast/report mapping. flows/ast-verification updated. All 14 AST aspects rewritten in prior commits.
