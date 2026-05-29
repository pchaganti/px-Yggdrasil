## [2026-05-15T10:17:15.671Z]
Fix deterministic violation: replace toLocaleString() with direct number interpolation — locale-independent output
## [2026-05-15T13:42:55.515Z]
R0.1 Phase 2: populate messageData alongside message at each buildIssueMessage call site. Structured IssueMessage now carried in CheckIssue; message string computed from it for backward compat.
## [2026-05-15T13:45:43.238Z]
R0.1 Phase 3: cli/check.ts now reads messageData via msg() helper to render issue output; buildIssueMessage called at CLI layer. Fallback to .message for issues not yet migrated in Phase 4.
## [2026-05-15T14:17:01.394Z]
Drop deprecated message field and buildIssueMessage import: CheckIssue objects now set only messageData; buildIssueMessage import removed from core layer. R0.1 Phase 5.
## [2026-05-16T04:54:08.442Z]
Remove dead flow-related branches: layer === 'flows' check in describeUpstreamCause and flowMatch block in groupCascadeByCause — flow YAML is no longer tracked, so these paths are unreachable. Also remove 'flow: --flow' from flagMap in computeSuggestedNext.
## [2026-05-16T05:58:05.490Z]
Phase 4.7 (no-direct-fs): route all fs calls through io/graph-fs.ts; update hash and paths imports from utils/ to io/ following module moves
## [2026-05-16T19:31:38.898Z]
Updated effective-aspects import path to core/graph/aspects following the file move.
## [2026-05-16T19:44:32.245Z]
Updated context-files import path to core/graph/files following the file move (collectTrackedFiles + TrackedFile). cli/core/context node drops context-files from its mapping; cli/core/graph node claims it.
## [2026-05-26T10:11:38.382Z]
Add comment explaining smaller STRUCTURAL_CODES set is internal-filter only, not CI blocking. The two sets have diverged historically; aligning them is tracked as dogfood cleanup, not in this change.
## [2026-05-28T10:37:57.697Z]
Drift cascade formatter now distinguishes reference-file changes from aspect-content changes. In describeCascadeCause, when a tracked file in the 'aspects' layer does not match the .yggdrasil/aspects/<id>/ path prefix, the file is a reference declared in some aspect's references: list. The formatter scans graph.aspects to find the declaring aspect(s) and emits 'reference file X (declared by aspect Y) changed' instead of the previous generic 'tracked file changed' fallback. This makes upstream-drift causes self-explanatory in yg check output for the new reference cascade source.
## [2026-05-28T13:13:47.979Z]
Render aspect-status by status: check now emits aspect-newly-active for non-draft effective aspects without a baseline verdict, aspect-violation-enforced (error) and aspect-violation-advisory (warning) for refused baselines. Per-node short-circuit moved from computeEffectiveAspects to hasNonDraftEffectiveAspects so all-draft nodes skip drift detection without spurious findings. GC predicate aligned with approve: drift state for nodes with no non-draft effective aspects is removed silently. Legacy baselines lacking aspectVerdicts are tolerated as 'implicitly approved' so the 5.x upgrade does not flood the user with aspect-newly-active. CheckResult adds advisoryWarnings and draftSkipped tallies; suggestedNext prefers an error's next over a warning's so an enforced violation outranks a co-emitted advisory.
## [2026-05-29T09:56:03.437Z]
check.ts core orchestrator updated to produce structured CheckResult output consumed by the new renderer. The grouped rendering logic was separated from the orchestration logic in this refactor.
## [2026-05-29T09:56:51.359Z]
Changed countDraftAspectsAcrossGraph to count UNIQUE draft aspect IDs (aspects whose aspect-level default is draft) rather than counting (node × aspect) pairs. The old count inflated the tally by multiplying one draft aspect across all nodes it reached via cascade channels. The new count reflects how many distinct aspect rules are dormant, which is the number that actually matters when an agent is assessing how much coverage is inactive.
## [2026-05-29T10:07:14.007Z]
core/check.ts updated: the check orchestrator now returns a structured CheckResult type with typed issue codes and cascadeCauses data, consumed by the new grouped check renderer.
## [2026-05-29T17:08:10.071Z]
Cross-node files that a structure-shape rule reads through a related component now count toward the dependent component's verification identity and its change-impact blast radius. Previously such a rule could inspect a sibling component's file, but the set of files brought into the dependent component's drift fingerprint was only assembled when the stored approval baseline was supplied to the file-collection routine — and the routine that gates everyday drift checks did not supply it. The consequence was a silent gap: editing a file that only a neighbour's structure rule reads never marked the dependent component as needing re-verification, and the change-impact query reported zero affected components for that file. The baseline is now supplied at the drift-detection points, and the canonical fingerprint is recomputed after the structure runner records the touched files, so the first approval already folds those cross-component files into the identity. Files the component owns directly stay classified as ordinary source changes; only genuinely cross-component paths receive the dedicated layer, and they are deliberately excluded from the owned-file map so a deleted-file scan never mistakes them for a vanished local file. A targeted single-rule re-approval now carries forward a sibling rule's recorded touched-file set instead of dropping it.
