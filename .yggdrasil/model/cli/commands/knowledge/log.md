## [2026-05-15T09:01:20.032Z]
Add yg knowledge list/read commands. Exports listKnowledge() and readKnowledge(name) as testable functions. Commander wrapper adds try/catch per cli-command-contract. Uses chalk.red for error output. Reads KNOWLEDGE_TOPICS from embedded CLI binary — no file access at runtime.
## [2026-05-16T18:22:20.940Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
