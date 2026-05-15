## [2026-05-15T10:17:15.781Z]
Fix posix-paths violation: normalize yggRoot (trim, backslash replace, trailing slash strip) at entry of each exported function
## [2026-05-15T13:32:17.143Z]
R0.9: remove direct node:fs imports — readFile and writeFile replaced with readTextFile and writeTextFile from io/graph-fs.ts. Engine types must not import node:fs directly per graph boundary conventions.
