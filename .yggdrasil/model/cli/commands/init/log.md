## [2026-05-15T16:03:14.564Z]
Delegate migration orchestration to core/migrator-runner.ts — thin wrapper now calls coreRunVersionUpgrade for the runMigrations/updateConfigVersion sequence, then handles CLI-layer concerns (refreshSchemas, architecture file creation, installRulesForPlatform)
## [2026-05-15T17:52:31.258Z]
Fix diagnostic-logging violations: add debugWrite() to multiple catch blocks that swallow errors without re-throwing.
## [2026-05-16T08:39:06.989Z]
Use buildIssueMessage for non-TTY already-exists warning: satisfies what-why-next aspect added via init flow
## [2026-05-16T18:22:20.812Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-16T18:54:56.640Z]
Wrapped --upgrade requires --platform error in buildIssueMessage. All option-validation messages in init now use the structured what/why/next form.
