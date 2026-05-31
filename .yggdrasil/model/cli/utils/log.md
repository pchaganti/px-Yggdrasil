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
## [2026-05-15T12:30:04.721Z]
R0.4b: atomic-write.ts removed from utils — moved to io/atomic-write.ts
## [2026-05-15T17:44:40.295Z]
Phase 2: reclassified from adapter to utility. Mapping changed from directory glob to explicit file list.
## [2026-05-16T05:58:12.129Z]
Phase 4.7 (no-direct-fs): removed hash.ts and paths.ts (moved to io/); refactored debug-log.ts to use injected AppendFn instead of importing appendFileSync directly
## [2026-05-28T06:03:27.920Z]
Added known-providers — a small constant module listing the LLM provider ids the CLI knows how to invoke. Consumed by io parsers, the format-version detector, and the migration runner. Single source of truth; previously lived in io but io has no concept for pure constants while utils does.
## [2026-05-30T07:12:18.020Z]
Introduced two shared helpers consumed by the AST and structure aspect runtimes: one canonical mapping-path normalizer and one check-module export-shape validator. Centralizing them removes the prior duplication where each runtime normalized paths slightly differently and each hand-wrote its own export-shape guard ladder with divergent wording; a single definition guarantees the two runtimes accept and reject the same inputs with the same guidance.
## [2026-05-31T16:03:35.528Z]
Replaced the hand-inlined path-separator normalization with calls to a single shared helper. The same small idiom — convert backslash separators to forward slashes, and in most places also strip a trailing slash — had been copied across many modules, so the normalization rule lived in dozens of places at once and any change to it risked drifting them out of step. Consolidating it behind one well-named helper means the rule lives in exactly one spot and each call site reads by intent instead of by a repeated regex. Behavior is unchanged: the helper bodies are byte-for-byte equivalent to the expressions they replace, and the full test suite passes identically.
