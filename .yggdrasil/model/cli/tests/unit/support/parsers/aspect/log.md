## [2026-05-29T05:14:32.236Z]
Add test for structure reviewer type. New test verifies that parseAspect accepts 'structure' as a valid reviewer.type value in aspect YAML.
## [2026-05-29T05:30:03.380Z]
Add test for aspect-references-on-structure error: structure aspects with references should be rejected. Tests placement above the aspect-references-on-ast check to establish more-specific-first ordering.
## [2026-05-29T05:35:22.177Z]
Add test for aspect-structure-tier-not-allowed error: structure aspects with tier should be rejected. Tests placement before the aspect-ast-tier-not-allowed check to establish more-specific-first ordering.
