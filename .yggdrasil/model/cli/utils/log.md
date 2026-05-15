## [2026-05-15T06:32:20.272Z]
Add repo-scan.ts: public walkRepoFiles helper with cascading gitignore, .yggdrasil/ exclusion, symlink skip, POSIX paths. Re-export from hash.ts for back-compat. Required for strict backward scan in validator (Phase 2).
## [2026-05-15T09:57:38.417Z]
resolveFileArg: resolve --file arg relative to repo root instead of CWD; remove cwd parameter
## [2026-05-15T12:12:58.692Z]
R0.3: repo-scan.ts removed — moved to io/repo-scanner.ts; utils now contains only pure helpers
## [2026-05-15T12:24:33.842Z]
R0.3: hash.ts re-exports updated from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:26:34.062Z]
Fix posix-paths violation in expandMappingPaths: file branch now normalizes path with replace(/\\/g, '/') matching directory branch
