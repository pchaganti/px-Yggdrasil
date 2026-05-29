## [2026-05-29T05:07:45.173Z]
Added test suite for expand-mapping-sync module. Tests cover path normalization (backslash/forward-slash handling, trailing-slash stripping) and membership testing logic (exact match, directory descendant detection, empty entry handling).
## [2026-05-29T06:06:45.187Z]
Added unit tests for collectAllowedReadsForAspect covering: own-mapping-minus-child carve-out (child wins when parent has sibling file entries), relation target mapping inclusion, port owner inclusion via relation targets, ancestor mapping inclusion, descendant mapping inclusion, missing-node empty-set, and transitive relation-target descendants. Added conformance test verifying that every source file tracked by collectTrackedFiles for a node is reachable within that node's collectAllowedReadsForAspect result set, confirming both functions draw from the same graph data structures (the single-source-graph-queries guarantee).
## [2026-05-29T06:21:14.601Z]
Test suite for ctx.fs facade. Covers allowed-set enforcement, touched-file tracking, and error handling for unmapped paths. Nine tests: exists/read/list operations validated for both success and rejection cases.
## [2026-05-29T06:27:08.589Z]
Added ctx-graph.test.ts: six deterministic unit tests for createCtxGraph. The tests verify the allowed-node guard (throws UndeclaredGraphReadError for undeclared targets), hierarchy access (parents always allowed), relation-target access including transitive children, nodesByType scoped to allowed nodes only, and children() both for own nodes and for relation-target subtrees. Each test uses a fresh mkdtempSync directory cleaned up in afterEach, ensuring no ambient state between runs.
## [2026-05-29T06:46:07.881Z]
Added unit tests for ctx-parsers: six tests covering parseYaml with touchedFiles tracking, parseJson, parseToml, parseAst from prewarmed cache (happy path with tree-sitter tree), parseAst cache miss error, and string-path input that reads from disk and tracks in touchedFiles.
## [2026-05-29T06:47:51.463Z]
Extended ctx-parsers tests with two additional tests for prewarmupAstCache: one verifying it populates astCache for TypeScript files and skips non-AST extensions (yaml), and one verifying it reuses existing cache entries when content is unchanged.
