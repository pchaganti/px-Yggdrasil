## [2026-05-15T17:44:12.755Z]
Phase 2: split from cli/ast — loader hook, parser, check runner, suppress. Type: ast-adapter.
## [2026-05-15T19:28:49.972Z]
Move IssueMessage type from formatters/message-builder to model/validation — engine→formatter import violation fix for boundaries enforcement
## [2026-05-26T09:43:17.807Z]
Add find-comments.ts reading comment node types from language registry per ctx.language. Two discriminated forms: file ({ ast, language }) or subtree ({ rootNode, language }). Both present throws AST_FINDCOMMENTS_AMBIGUOUS_TARGET; unknown language throws AST_FINDCOMMENTS_UNKNOWN_LANGUAGE. Errors propagate through runner's AST_CHECK_THROWN path. Task 28 reassigns to cli/ast/report alongside walk/file-path/index.
