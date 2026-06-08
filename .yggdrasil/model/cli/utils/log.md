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
## [2026-05-31T16:51:20.857Z]
Moved the pure when-predicate parsers (file-level and aspect-level, plus the shared boolean-clause helper they both use) out of the core layer and into the shared utilities layer. The file-reading parsers in the io layer need these helpers, but the layering rules forbid the io layer from depending on core/engine code; placing the helpers among the leaf utilities — which any layer may import — makes that dependency legal without weakening the rule. The helpers are pure: they transform already-parsed objects and do no file I/O, so they belong with the other shared utilities rather than with the engine. Importers and the relocated files internal paths were updated accordingly.
## [2026-06-08T15:11:08.903Z]
Node mapping entries and architecture file-classification predicates now accept glob patterns (minimatch syntax: a single "*" matches within one path segment and does not cross a slash; "**" spans segments). This area carries the single shared decision of whether a given file is covered by a mapping entry, so that ownership, coverage scanning, file expansion, and validation all agree. The motivation: a team adopting enforcement on a folder that mixes — for example — repository classes with unrelated helper files needs to scope a rule to just the files matching a naming pattern, instead of being forced to either pull the whole folder into one node or enumerate every file by hand. Plain (non-glob) entries keep their prior meaning: an exact file path, or a directory prefix that covers everything beneath it.
## [2026-06-08T16:05:30.880Z]
The path-matching utility now exposes a single low-level glob primitive, and every glob match across the system routes through it, so glob semantics are defined in exactly one place. This was prompted by a defect: glob support had been added to the entry-vs-file matcher, but separate code paths did their own literal path comparison and silently bypassed it. Consolidating the primitive here removes the class of bug where a new match site quietly diverges from the rest.
## [2026-06-08T16:40:57.064Z]
Glob detection now treats only the star wildcard as a glob trigger; the other minimatch metacharacters (question mark, square brackets, braces) are literal path characters. A file whose real name contains brackets or braces — as in framework route conventions that put a bracketed dynamic segment in the filename — therefore maps literally instead of being misread as a pattern. Such names could not be escaped anyway, because path normalization strips backslashes. A star-glob that also contains brackets still has them interpreted (opting into glob via a star opts into the rest).
