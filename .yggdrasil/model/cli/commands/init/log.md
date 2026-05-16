## [2026-05-15T16:03:14.564Z]
Delegate migration orchestration to core/migrator-runner.ts — thin wrapper now calls coreRunVersionUpgrade for the runMigrations/updateConfigVersion sequence, then handles CLI-layer concerns (refreshSchemas, architecture file creation, installRulesForPlatform)
## [2026-05-15T17:52:31.258Z]
Fix diagnostic-logging violations: add debugWrite() to multiple catch blocks that swallow errors without re-throwing.
## [2026-05-16T08:39:06.989Z]
Use buildIssueMessage for non-TTY already-exists warning: satisfies what-why-next aspect added via init flow
