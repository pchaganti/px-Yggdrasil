## [2026-05-27T07:22:02.468Z]
New test node for v5 reviewer-tiers unit tests: tier-identity.test.ts verifies canonical JSON ordering, api_key exclusion; tier-selection.test.ts verifies aspect-to-tier resolution (explicit tier, default tier, error cases); format-version.test.ts verifies v4/v5 config and aspect YAML shape detection predicates.
## [2026-05-27T07:40:44.201Z]
Added test for array-valued LlmConfig fields in canonicalTierJson — exercises the Array.isArray branch in canonicalJson to maintain branch coverage above 90% threshold after adding new source files.
## [2026-05-27T13:55:04.200Z]
Format-version unit tests updated to import the renamed isCurrent / isLegacy predicates and the additional mixed-format coverage cases.
## [2026-05-30T18:08:13.613Z]
The vocabulary for how a rule is verified was reduced from three kinds to two. Previously a rule was checked by one of: a human-language reviewer, a single-file programmatic check, or a graph-aware programmatic check. The two programmatic kinds are now a single "deterministic" kind, leaving just deterministic-or-reviewer.

The motivation: the three-way split was drawn on the wrong axis. It described HOW a programmatic check reached its context (one file at a time, versus the whole graph), but the distinction that actually matters to a rule author and to cost is whether verification is local-and-free or requires the paid, non-deterministic reviewer. The single-file kind was already a strict subset of the graph-aware kind — every input the former could see, the latter also provides — so maintaining two of them forced rule authors to make a false choice up front and forced the engine to carry two parallel handling paths for one concept. Collapsing them removes that false choice and the duplicated handling, and routes every programmatic check through the one graph-aware path.

The language a programmatic check infers for a source file is determined solely from that file's extension, so a check no longer declares which languages it targets. A rule's verification kind being deterministic is also no longer carried as a separate synthetic identity signal — a deterministic rule's identity is fully covered by the files it already tracks — which keeps re-verification of such rules free.
## [2026-05-31T21:54:26.699Z]
Removed format-version.test.ts from the reviewer-tiers test node mapping. That test file was renamed and relocated to migrations/format-detect.test.ts alongside the source module it tests.
