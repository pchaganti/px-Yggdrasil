## [2026-05-27T07:22:38.664Z]
Phase 6 type-bridge: aspects.test.ts makeAspect helper updated to accept string shorthand for reviewer and convert to AspectReviewerSpec object form; string literals 'ast' / 'llm' in test calls remain valid via the helper bridge.
## [2026-05-28T14:02:06.781Z]
Add tests covering visible aspect status in graph-oriented CLI commands. yg aspects test asserts [<status>] tags appear next to each aspect id. yg find tests assert a status: <enum> line appears for aspect-kind results (default enforced and explicitly declared draft). yg impact tests assert effective status tags appear on directly affected nodes (--aspect) and on the Aspects: summary line (--node).
## [2026-05-28T19:39:36.893Z]
Tests for the new yg impact rendering-flip annotation: one case seeds a refused aspectVerdict in drift state and asserts the annotation appears; one case seeds an approved verdict and asserts no annotation.
## [2026-05-28T19:44:24.810Z]
Updated impact.test.ts assertion: file->nodePath message now flows through stdout (was stderr). Assertion checks stdout for full 'src/orders/order.service.ts -> orders/order-service' text instead of partial path on stderr. Matches the cli/commands/impact stdout-routing fix in the same review cycle.
