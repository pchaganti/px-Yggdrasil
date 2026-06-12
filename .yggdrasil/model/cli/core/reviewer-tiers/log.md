## [2026-05-27T07:21:58.593Z]
New node: tier-identity.ts computes canonical JSON for drift detection of LLM tier config (excluding api_key which rotates independently); tier-selection.ts resolves aspect-to-tier mapping supporting explicit tier references and default-tier fallback; format-version.ts detects v4 vs v5 config/aspect YAML shapes. These three files implement the core v5 reviewer-tiers domain logic introduced to support named tiers in ReviewerConfig.
## [2026-05-27T13:54:43.693Z]
Format-version detector consolidated. The shared module is now the single source of truth: predicates renamed from version-numbered names to behaviour-named ones (isCurrent / isLegacy). Provider list extracted to a leaf module so detector and parser can both import without a cycle. Predicate semantics unchanged.
## [2026-05-28T06:03:27.632Z]
Import path of KNOWN_PROVIDERS updated to follow the move to utils. The format-version detector still imports the same constant; behaviour unchanged.
## [2026-05-29T07:18:00.437Z]
Exported the module-private canonicalJson helper from tier-identity.ts so it can be used by core/graph/files.ts to produce stable canonical JSON for structure-aspect identity hashes. The function itself is unchanged; only its visibility changed from module-private to module-exported.
## [2026-05-29T20:38:46.685Z]
The per-call reviewer timeout is now excluded from the synthetic tier-identity drift hash, alongside the already-excluded api_key. Timeout is an operational knob — how long to wait for the reviewer subprocess — that does not change the reviewer's judgment, so it must not invalidate existing verdict baselines. Including it meant that tuning the timeout changed the tier-identity of every node carrying an LLM aspect, cascading drift across the whole graph and forcing a full re-approval just to adjust a wait duration. Excluding it lets the timeout be tuned freely without any drift.
## [2026-06-01T06:21:23.907Z]
Documentation-only adjustment: the comment describing where the canonical reviewer-tier serialization is consumed was updated to reflect that the tier-identity hash is now stored as a typed per-aspect identity field rather than as a prefixed synthetic key folded into the file-hash map. No logic change; the serialization that excludes the API key from the tier identity is unchanged.
## [2026-06-12T14:17:39.266Z]
max_prompt_chars is now excluded from canonicalTierJson alongside api_key and timeout. All three are operational or infrastructure fields that must not invalidate recorded baselines when changed: api_key rotates independently, timeout is a subprocess wait knob, and max_prompt_chars is a prompt-size gate checked before the LLM call.
