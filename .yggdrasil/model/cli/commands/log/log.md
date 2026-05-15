## [2026-05-15T12:24:34.046Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:30:04.814Z]
R0.4b: log-add.ts import updated from utils/atomic-write to io/atomic-write (no logic change)
## [2026-05-15T12:41:10.519Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.563Z]
R0.6: update log-parser import — log-add.ts, log-read.ts, log-merge-resolve.ts now import parseLog from core/parsing/log-parser (moved from io/ to core/parsing/). No logic change.
## [2026-05-15T16:20:59.852Z]
Thin wrapper now delegates log-add/read/merge-resolve logic to core/log/. Presentation (chalk, buildIssueMessage, process.exit) and --reason-file reading remain at CLI layer.
## [2026-05-15T16:28:22.013Z]
R0.10: rewrote cli/log.ts as pure presentation layer — removed direct fs/parsing logic, imports logAdd/logRead/logMergeResolve from core/log/, handles --reason-file and graph loading, normalizes node path with trim+posix before passing to core.
