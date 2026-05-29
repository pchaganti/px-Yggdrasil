## [2026-05-29T09:56:03.753Z]
aspect-status-lifecycle integration test updated to match the new check output format. Advisory violation now renders in a Warnings block rather than inline with an aspect-violation-advisory code.
## [2026-05-29T09:57:04.223Z]
Updated aspect-violation-advisory rendering assertion in yg check integration test. The old test expected the internal code string 'aspect-violation-advisory' in the output and the old 'Result: PASS' footer. The new format uses an 'advisory' label in the Warnings section and a 'yg check: PASS (N warnings)' header, so the assertions were updated accordingly.
## [2026-05-29T10:07:14.456Z]
Aspect-status lifecycle test updated to match the new grouped check output format. Advisory violations now render in a 'Warnings (N):' block with 'advisory' label.
