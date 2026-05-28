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
## [2026-05-16T19:12:22.102Z]
Wrapped '.yggdrasil exists but is not a directory' error in buildIssueMessage. All raw error writes in init.ts now route through buildIssueMessage or abortOnUnexpectedError.
## [2026-05-27T12:26:25.442Z]
Updated writeReviewerConfig to emit v5 tiers format: reviewer.tiers.standard with provider, consensus, and config block instead of v4 flat provider keys. The v5 format aligns with the config parser which rejects v4-format configs at load time.
## [2026-05-27T13:54:33.050Z]
Comment cleanup — removed version-numbered phrasing so the comment describes what the code does rather than which schema iteration introduced it.
## [2026-05-28T05:09:49.559Z]
Init upgrade command no longer threads fromVersion or toVersion through to the runner. The runner reads the current project version from yg-config.yaml itself, runs every applicable migration incrementally, and reports the landed version. The wrapper simply forwards the migration list, refreshes schemas, and installs rules.
