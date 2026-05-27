## [2026-05-15T13:00:20.230Z]
Initial creation: split from cli/io parent (wide-node false positive blocked silent-missing-files approve with 14 files). Stores child contains 6 files responsible for drift state persistence, find index, artifact reading, git-ignore scanning, atomic writes, and low-level fs utilities; inherits yaml-parser-contract, silent-missing-files, diagnostic-logging from parent via channel 2.
## [2026-05-15T13:32:21.184Z]
R0.9: add writeTextFile to graph-fs.ts — io/stores now exports both read and write fs utilities. Used by migrator.ts to avoid direct node:fs imports in engine types.
## [2026-05-15T13:56:01.081Z]
R0.1 Phase 4: io/find-index.ts removes buildIssueMessage import — inline template literals replace formatter calls for direct stderr diagnostic writes.
## [2026-05-15T16:21:06.596Z]
Add log-store.ts — readLogSafe, statLogFile, writeLogFile — fs operations for log.md that core/log modules route through instead of using node:fs directly.
## [2026-05-15T16:28:17.782Z]
R0.10: added log-store.ts — fs wrapper for log.md files (readLogSafe, statLogFile, writeLogFile) with diagnostic-logging on ENOENT catch blocks.
## [2026-05-15T17:44:23.192Z]
Phase 2: reclassified from adapter to persistence-adapter. Removed atomic-write.ts (split to cli/io/atomic-write).
## [2026-05-16T05:58:12.005Z]
Phase 4.7 (no-direct-fs): moved hash.ts and paths.ts here from utils/ (now persistence-adapter); added debug-log-writer.ts (appendFileSync DI implementation); expanded graph-fs.ts with fileAccess, lstatFile, statPath, fileExistsSync wrappers
## [2026-05-16T08:19:17.767Z]
Add calls relation to cli/io/atomic-write with consumes: [write-atomic] — declares the port contract so channel 6 propagates atomic-write-contract to this node
## [2026-05-16T17:17:49.788Z]
Migrated log-store.readLogSafe to the new readFileOrDefault helper (io/read-or-default.ts). The helper handles ENOENT uniformly, rethrows other errors, and emits a single debugWrite line on miss. Other IO sites (secrets-parser, repo-scanner, find-index, log-store.statLogFile) intentionally retain their existing semantics — they catch all errors silently (different from ENOENT-only) or operate on stat instead of readFile, so they do not fit the helper. The persistence-adapter type's when predicate and the cli/io/stores node mapping were extended to include the new file.
## [2026-05-16T19:44:32.383Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-26T10:40:16.945Z]
Rewrote atomic-write-contract check.mjs against raw tree-sitter API (walk + report + inFile from @chrisdudek/yg/ast). The old code used ast.imports() and accessed imp.specifiers which does not exist on ImportInfo — it was effectively a no-op. The new code walks import_statement nodes directly to collect fs-module specifiers, then walks call_expression nodes to detect direct raw write calls. Added graph-fs.ts to the exemption list to preserve the existing enforcement boundary: graph-fs.ts is the low-level fs facade layer that wraps raw node:fs/promises for other adapters and is intentionally allowed to call writeFile directly. Verified behavior-identical via ast-test diff.
## [2026-05-27T07:22:31.582Z]
Phase 6 type-bridge: find-index.ts updated reviewer comparison from aspect.reviewer !== 'ast' to aspect.reviewer.type !== 'ast' to match AspectReviewerSpec object shape.
