## [2026-05-15T08:40:14.535Z]
Add yg type-suggest --file command: suggests node_type based on architecture when predicates. Shows matching types, closest 3 by satisfied-fraction, or edge-case messages for .yggdrasil/ and non-existent files.
## [2026-05-15T10:11:11.572Z]
Restructure: loadGraph first, resolve --file via resolveFileArg(repoRoot), fix posix-paths trailing slash strip
## [2026-05-15T12:12:58.996Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:28:18.002Z]
R0.4: file-content-cache import updated from core to io (no logic change)
## [2026-05-15T12:36:42.834Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.616Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
