## [2026-05-13T05:48:00.416Z]
Distinguish WhenPredicateInvalidError when loading architecture.

Why: Plan Task 1.7. Graph.architectureError changed from bare string to ArchitectureLoadError (string | { code; message }) so downstream validators can emit a 'when-predicate-invalid' error code instead of folding the failure into generic architecture-invalid.

How to apply: graph-loader catches WhenPredicateInvalidError and returns structured form; falls back to bare-string for all other errors so legacy consumers keep working. Plan Task 1.7.
## [2026-05-15T09:13:17.213Z]
Add version gate: after findYggRoot, detect config version via detectVersion(yggRoot). If version > CLI_SUPPORTED_SCHEMA (4.4.0), throw with upgrade instruction. Gate runs before config parsing and is not affected by tolerateInvalidConfig. Uses semver.gt and semver.valid for comparison.
## [2026-05-15T12:24:34.251Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:36:43.047Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.205Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.776Z]
R0.6: update file-when-parser import — graph-loader.ts now imports WhenPredicateInvalidError from ./parsing/file-when-parser (moved from io/). No logic change.
## [2026-05-16T05:58:05.723Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T13:40:07.885Z]
Version gate: CLI_SUPPORTED_SCHEMA updated 4.4.0 → 4.3.0 — versions above 4.3.0 now trigger upgrade instruction. Part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
## [2026-05-16T13:49:38.797Z]
Fix what-why-next aspect violation: nodeParseErrors now stores IssueMessage (what/why/next) instead of raw message string; architectureError raw-string case now returns structured { code, messageData } object. ArchitectureLoadError type updated to remove bare string option. Graph model and validator.ts updated to match.
## [2026-05-27T07:55:35.923Z]
Updated loadAspects and scanAspectsDirectory to collect parse errors from parseAspect into a structured parseErrors array. The function now returns {aspects, parseErrors} instead of just AspectDef[]. loadGraph wires the errors into Graph.aspectParseErrors so validators downstream can surface them. This is phase 7 of the v5 reviewer-tiers feature: aspect YAML malformation is now surfaced instead of silently swallowed.
## [2026-05-27T09:08:38.920Z]
Updated graph-loader.ts to capture ConfigParseError from config-parser.ts as a structured error. The ConfigParseError now carries an IssueMessage and error code, enabling the validator to distinguish between legacy-format config errors and generic parse failures. This allows downstream validators to suppress dependent checks (e.g., aspect-tier-unknown) when the config is in the legacy v4 format.
## [2026-05-27T12:59:41.327Z]
Bumped CLI_SUPPORTED_SCHEMA from '4.3.0' to '5.0.0' so the CLI accepts v5-versioned yg-config.yaml files. Without this, loading the dogfood config after the version bump fails with 'newer than this CLI supports'.
