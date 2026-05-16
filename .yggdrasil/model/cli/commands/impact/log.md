## [2026-05-15T08:46:12.622Z]
Add --type <id> mode: shows type metadata (description, enforce, when, aspects), nodes of that type with count, source files covered (up to 20), and strict coverage gap (orphans + misplaced) when enforce=strict. Mutex with --node/--file/--aspect/--flow.
## [2026-05-15T09:57:38.623Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T12:12:58.897Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:28:17.897Z]
R0.4: file-content-cache import updated from core to io (no logic change)
## [2026-05-15T20:45:36.280Z]
Add debugWrite() to catch block — required by diagnostic-logging aspect to surface errors via debug channel.
## [2026-05-16T03:57:21.039Z]
Fix: stdout (not stderr) for --file resolution success message; add debugWrite() already present in catch block.
## [2026-05-16T04:42:33.168Z]
Revert file->node resolution to stderr — test suite explicitly expects this diagnostic output on stderr (not stdout). The previous change was incorrect.
## [2026-05-16T05:57:55.222Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
