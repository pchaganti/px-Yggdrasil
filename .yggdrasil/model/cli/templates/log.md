## [2026-05-15T10:45:56.847Z]
Redesign rules.ts and knowledge: extract log-management, ports-and-relations, flows as new knowledge topics; trim rules.ts CLI table to essentials with route to cli-reference; remove duplicate authz rule from suppress-syntax (kept in rules.ts as behavioral rule); remove duplicate cross-file-evasion section from working-with-architecture (moved to ports-and-relations); remove 7-channels table + brownfield signs from aspects-overview (kept in rules.ts as mental model and Aspect Discovery heuristic); add per-node-independent-execution detail to drift-and-cascade; expand 'Where to find more' routing table to all 12 topics. Goal: rules.ts stays a lean primer + router (always loaded); knowledge holds deep reference (on-demand). Nothing lost — every fact preserved in either rules.ts or some knowledge file.
## [2026-05-15T10:47:19.010Z]
Lint fix: escape pipe inside CLI essentials table row at TypeScript level (\\| → renders as \| in markdown so the | between flags is literal text, not column separator). Output-equivalent semantic, ESLint no-useless-escape compliant.
## [2026-05-15T11:03:40.337Z]
Restore three items I had over-trimmed during the redesign — user feedback that nothing should be lost from rules.ts: (1) re-add yg-suppress proposal procedure step 1 ('Show the user the violation and explain why the code cannot comply now') as an explicit numbered step in the rules.ts Authorization section — previously only implicit in 'PROPOSE'. (2) re-add the yg log merge-resolve narrative paragraph (what the tool validates, why not to concatenate manually) to the rules.ts 'Log management — workflow' section — previously only in log-management knowledge. (3) re-add yg log merge-resolve to the rules.ts CLI essentials table. Knowledge files keep their full coverage too.
## [2026-05-15T17:44:40.170Z]
Phase 2: reclassified from adapter to template. Mapping narrowed to {default-config,platform,rules}.ts. Knowledge docs moved to cli/knowledge.
## [2026-05-16T08:39:07.651Z]
installRulesForPlatform: normalize returned path with POSIX replace before returning — satisfies posix-paths-output aspect added via init flow
## [2026-05-16T13:46:18.742Z]
Update default-config.ts and knowledge/configuration.ts: version 4.4.0 → 4.3.0 as part of flattening 4.3.0+4.4.0 into single 4.3.0 release.
