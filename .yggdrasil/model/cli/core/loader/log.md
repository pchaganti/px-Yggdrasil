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
