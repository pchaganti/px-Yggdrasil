## [2026-05-26T08:49:07.211Z]
Added walk(node, visitor) test cases to walk.test.ts: verifies document-order preorder traversal, that returning false skips a subtree while continuing siblings, that returning undefined or true both allow normal descent.
## [2026-05-26T08:54:28.181Z]
Extended report.test.ts with column field test. The existing test was updated to include the new column property in the expected Violation object.
## [2026-05-26T09:44:05.128Z]
Add find-comments.test.ts to mapping — covers the new findComments function which reads comment types from the language registry. Tests file-form and subtree-form discrimination, ambiguous-target guard, and unknown-language guard.
