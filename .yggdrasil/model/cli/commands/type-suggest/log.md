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
## [2026-05-16T05:58:01.036Z]
Phase 4.7 (no-direct-fs): update paths import from utils/ to io/ following move of paths module to persistence-adapter layer
## [2026-05-16T06:34:16.259Z]
Phase 5.2 (posix-paths-output): add backslash replacement to repoRelPath normalization
## [2026-05-16T17:37:14.424Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:21.440Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
