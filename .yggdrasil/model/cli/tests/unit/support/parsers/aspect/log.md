## [2026-05-29T05:14:32.236Z]
Add test for structure reviewer type. New test verifies that parseAspect accepts 'structure' as a valid reviewer.type value in aspect YAML.
## [2026-05-29T05:30:03.380Z]
Add test for aspect-references-on-structure error: structure aspects with references should be rejected. Tests placement above the aspect-references-on-ast check to establish more-specific-first ordering.
