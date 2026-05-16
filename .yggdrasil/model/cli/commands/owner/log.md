## [2026-05-15T09:57:38.520Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T17:52:31.476Z]
Fix diagnostic-logging violations: add debugWrite() to catch block that swallows access() error.
## [2026-05-16T05:57:55.359Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
