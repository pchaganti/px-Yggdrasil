## [2026-05-15T16:03:14.564Z]
Delegate migration orchestration to core/migrator-runner.ts — thin wrapper now calls coreRunVersionUpgrade for the runMigrations/updateConfigVersion sequence, then handles CLI-layer concerns (refreshSchemas, architecture file creation, installRulesForPlatform)
