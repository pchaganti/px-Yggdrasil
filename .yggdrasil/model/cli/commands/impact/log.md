## [2026-05-15T08:46:12.622Z]
Add --type <id> mode: shows type metadata (description, enforce, when, aspects), nodes of that type with count, source files covered (up to 20), and strict coverage gap (orphans + misplaced) when enforce=strict. Mutex with --node/--file/--aspect/--flow.
## [2026-05-15T09:57:38.623Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T12:12:58.897Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:28:17.897Z]
R0.4: file-content-cache import updated from core to io (no logic change)
