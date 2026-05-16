## [2026-05-15T12:24:33.944Z]
R0.3: cascade from cli/io metadata update (repo-scanner.ts added to mapping)
## [2026-05-15T12:36:42.733Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.419Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T19:19:07.244Z]
Fix diagnostic-logging: add debugWrite() to both catch blocks in find.ts to satisfy the aspect requirement that all swallowed errors are logged via debugWrite before returning or exiting
## [2026-05-16T06:34:16.133Z]
Phase 5.2 (posix-paths-output): normalize doc.path before writing to stdout
## [2026-05-16T17:37:13.679Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.435Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
