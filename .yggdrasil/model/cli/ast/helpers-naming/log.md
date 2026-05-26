## [2026-05-15T17:44:12.642Z]
Phase 2: split from cli/ast — naming/path AST helpers (casing, file-path, jsx, name). Type: ast-adapter.
## [2026-05-26T08:56:10.255Z]
Replace inFile string signature with discriminated object { glob | regex | contains }. Hard break; legacy ast.inFile(file, string) gets backward shim in ast/index.ts (Task 9) during transition window.
## [2026-05-26T10:35:20.014Z]
Rewrote aspect posix-paths-source against raw tree-sitter API. Replaced ast.within() traversal and string-based ast.inFile() with walk() + early return (false) on member_expression and string nodes, and inFile({glob:...}) object form. Verified behavior-identical via ast-test diff.
