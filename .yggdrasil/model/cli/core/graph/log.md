## [2026-05-16T19:18:57.383Z]
Initial population: pure graph-query helpers extracted from context-builder and when-evaluator. Reason: establish a canonical home so future graph queries land in one place. Three helpers move here in this task — traversal (collectAncestors, collectDescendants), flows (collectParticipatingFlows), dependencies (collectDependencyAncestors + DependencyAncestorInfo). Two more files move in subsequent tasks (effective-aspects, context-files). Aspect locking the location is added after the moves.
## [2026-05-16T19:31:38.504Z]
Added aspects.ts (computeEffectiveAspects + getAspectSource). Previously in core/effective-aspects.ts; moved here in this task and exported through the barrel. dependencies.ts updated to import from sibling. Internal imports rewired (../model -> ../../model, ./when-evaluator -> ../when-evaluator, etc).
## [2026-05-16T19:44:31.717Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-26T09:35:08.837Z]
Add language-registry.ts as phase 1 stub. Three languages with extension mapping, comment types, override getter. Pure data + pure functions per engine aspect compliance. Layering pin: validator imports from this module (precedent via core/graph/aspects.js). Phase 3 expands to 35 tier 1 languages, populates grammar pins.
