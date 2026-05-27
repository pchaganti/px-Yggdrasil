## [2026-05-15T16:04:09.399Z]
New orchestration module — sequences runMigrations + updateConfigVersion from migrator.ts, flattens migration actions/warnings into UpgradeResult. Extracted from cli/init.ts::runVersionUpgrade so the version-upgrade sequence lives in the engine layer without presentation concerns.
## [2026-05-27T07:22:23.871Z]
Phase 1 change: updated migrator-runner to work with new ReviewerConfig and AspectReviewerSpec types after the v5 reviewer-tiers model change.
