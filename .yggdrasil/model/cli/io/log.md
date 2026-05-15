## [2026-05-12T11:01:18.102Z]
Add stderr warnings to find-index.ts for two cases spec required: filesystem error reading log.md (was debug-only), and log.md truncation >1MB (was silent). Both now emit buildIssueMessage-style warnings on stderr while continuing indexing.
## [2026-05-13T05:19:31.112Z]
Accept empty/commented yg-architecture.yaml in parseArchitecture.

Why: 4.4.0 needs yg init to ship a placeholder architecture (commented-only example) and greenfield repos must pass yg check before any node_types are defined. Design §10 L1405 explicitly allows 'pusta lub tylko komentarze'.

How: top-level null/undefined raw and null/undefined node_types now fall back to empty {}. Non-mapping top-level shapes (arrays, scalars) still rejected with descriptive error. Plan Task 1.1.
## [2026-05-13T05:48:00.315Z]
Extend architecture-parser with when + enforce.

Why: Plan Task 1.7. ArchitectureNodeType now carries optional when:FileWhenPredicate for per-file classification and enforce:'strict' for backward enforcement. The parser must validate these fields, route 'when' through parseFileWhen so regex syntax is checked at load time, and reject any enforce value other than 'strict'.

How to apply: WhenPredicateInvalidError thrown by parseFileWhen bubbles up unchanged so the graph loader can translate it into ArchitectureLoadError code 'when-predicate-invalid' (distinct from generic architecture-invalid). Enforce parsing is a strict literal check. Plan Task 1.7.
## [2026-05-13T05:55:25.055Z]
Conform secrets-parser and architecture-parser to yaml-parser-contract literal (parseYaml(content) as Record<string, unknown>).

Why: Reviewer flagged 'as unknown' as a deviation from the literal pipeline text. Both files use 'as unknown' because they accept missing/empty input where parseYaml returns null, but the contract documents the cast shape. Per user decision: conform code rather than relax the aspect (smaller blast radius, keeps a single canonical pipeline).

How to apply: cast is now Record<string, unknown> in both files (the cast is a TS-level convenience when raw is null at runtime; subsequent null/Array.isArray checks remain the runtime gate). Resolves the approve rejection from the previous attempt; covers the same Task 1.7 cycle.
## [2026-05-15T06:18:08.224Z]
Fix silent-missing-files violation in find-index.ts: ENOENT on log.md is expected for freshly created nodes; only emit warning for non-ENOENT errors, silently skip with debugWrite for absent files.
## [2026-05-15T12:12:58.592Z]
R0.3: repo-scanner.ts moved here from utils/repo-scan.ts (io adapter, not a pure helper — reads fs)
