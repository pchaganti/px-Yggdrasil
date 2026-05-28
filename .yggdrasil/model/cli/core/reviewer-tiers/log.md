## [2026-05-27T07:21:58.593Z]
New node: tier-identity.ts computes canonical JSON for drift detection of LLM tier config (excluding api_key which rotates independently); tier-selection.ts resolves aspect-to-tier mapping supporting explicit tier references and default-tier fallback; format-version.ts detects v4 vs v5 config/aspect YAML shapes. These three files implement the core v5 reviewer-tiers domain logic introduced to support named tiers in ReviewerConfig.
## [2026-05-27T13:54:43.693Z]
Format-version detector consolidated. The shared module is now the single source of truth: predicates renamed from version-numbered names to behaviour-named ones (isCurrent / isLegacy). Provider list extracted to a leaf module so detector and parser can both import without a cycle. Predicate semantics unchanged.
## [2026-05-28T06:03:27.632Z]
Import path of KNOWN_PROVIDERS updated to follow the move to utils. The format-version detector still imports the same constant; behaviour unchanged.
