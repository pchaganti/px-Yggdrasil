## [2026-05-15T17:44:12.523Z]
Phase 2: split from cli/ast — syntactic AST helpers (call, decorators, exports, imports, modifiers, walk). Type: ast-adapter.
## [2026-05-26T08:48:10.348Z]
Add walk(node, visitor) preorder traversal primitive alongside existing within/closest. Visitor returning false skips subtree. within and closest remain functional during aspect rewrite transition (tasks 14-27). Task 28 removes within (helpers-syntactic deleted); closest moves to cli/ast/report per minimal-API design.
