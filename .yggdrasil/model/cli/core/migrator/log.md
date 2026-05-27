## [2026-05-15T10:17:15.781Z]
Fix posix-paths violation: normalize yggRoot (trim, backslash replace, trailing slash strip) at entry of each exported function
## [2026-05-15T13:32:17.143Z]
R0.9: remove direct node:fs imports — readFile and writeFile replaced with readTextFile and writeTextFile from io/graph-fs.ts. Engine types must not import node:fs directly per graph boundary conventions.
## [2026-05-27T07:22:23.741Z]
Phase 1 change: AspectDef.reviewer changed from optional string union to required AspectReviewerSpec object; migrator updated to handle v4-to-v5 config migration including new ReviewerConfig.tiers structure.
