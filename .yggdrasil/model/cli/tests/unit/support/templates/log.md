## [2026-05-26T11:01:28.035Z]
Update knowledge.test.ts required headings for writing-ast-aspects topic: old headings (check.mjs structure, The twelve helpers, Purity rule) no longer present after rewrite to raw tree-sitter API. New required headings reflect the rewritten structure: When to use AST, Runtime contract, Minimal API table, Testing with yg ast-test, Migration table.
## [2026-05-27T12:45:43.909Z]
Updated default-config test to expect version 5.0.0 (matching the DEFAULT_CONFIG change) and updated the knowledge configuration test heading from 'Reviewer tiers' to 'Provider configs' to match the renamed section.
## [2026-05-27T13:55:07.298Z]
Required-heading list updated for the configuration knowledge topic now that the section formerly titled Provider configs has been renamed to Reviewer tiers.
## [2026-05-28T15:30:17.295Z]
Update knowledge topic tests for new aspect-status topic: increment expected count to 13, add aspect-status to sorted names list, add required heading assertions
## [2026-05-29T08:36:51.010Z]
Updated knowledge topic count assertion from 13 to 14 and added writing-structure-aspects to the expected topic names list and required headings table to match the new knowledge topic introduced alongside this test change.
## [2026-05-30T20:06:21.887Z]
The way a rule's verification is declared collapsed from three kinds — a human-language reviewer, a single-file programmable check, and a graph-aware programmable check — down to two: the human-language reviewer and one unified deterministic programmable check. The two programmable kinds were never a real choice, since the graph-aware kind is a superset of the single-file one; keeping both forced authors into a false up-front decision and made the tooling carry two parallel surfaces for one concept. Collapsing them removes that false choice. This change consolidates the remaining user-facing surface that still exposed the old split.

Specific to this node: the template tests are updated because the knowledge registry shrank by one topic (two merged into one) and the system-prompt sections were rewritten to the two-type vocabulary; the suite's expected topic set, count, and section assertions now reflect the consolidated surface.
