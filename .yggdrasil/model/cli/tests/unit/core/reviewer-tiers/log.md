## [2026-05-27T07:22:02.468Z]
New test node for v5 reviewer-tiers unit tests: tier-identity.test.ts verifies canonical JSON ordering, api_key exclusion; tier-selection.test.ts verifies aspect-to-tier resolution (explicit tier, default tier, error cases); format-version.test.ts verifies v4/v5 config and aspect YAML shape detection predicates.
## [2026-05-27T07:40:44.201Z]
Added test for array-valued LlmConfig fields in canonicalTierJson — exercises the Array.isArray branch in canonicalJson to maintain branch coverage above 90% threshold after adding new source files.
## [2026-05-27T13:55:04.200Z]
Format-version unit tests updated to import the renamed isCurrent / isLegacy predicates and the additional mixed-format coverage cases.
