## [2026-05-15T16:04:09.399Z]
New orchestration module — sequences runMigrations + updateConfigVersion from migrator.ts, flattens migration actions/warnings into UpgradeResult. Extracted from cli/init.ts::runVersionUpgrade so the version-upgrade sequence lives in the engine layer without presentation concerns.
## [2026-05-27T07:22:23.871Z]
Phase 1 change: updated migrator-runner to work with new ReviewerConfig and AspectReviewerSpec types after the v5 reviewer-tiers model change.
## [2026-05-28T05:09:52.679Z]
Runner now owns incremental version bumping. Each applicable migration runs in semver order; after each successful migration the runner writes the migration target into yg-config.yaml so the next step observes the freshly advanced version. A migration that returns bumpVersion false stops the chain and leaves the project at the last successfully completed step. The runner no longer accepts a global toVersion or a fromVersion parameter; the current version is detected from yg-config.yaml on entry. The result now includes the fromVersion and landedVersion for callers that need to display the journey.
