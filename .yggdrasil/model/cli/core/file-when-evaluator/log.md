## [2026-05-13T05:38:36.351Z]
Initial creation: file-when-evaluator.ts.

Why: Plan Task 1.5. Architecture-level node_type when needs a deterministic per-file evaluator that returns (result, trace) so error messages can show a tree of ✓/✗ atoms. The trace also carries 'detail' strings (binary, >5MB, unreadable) so users see why a content predicate evaluated false even when the file matched the path predicate.

How to apply: recursive evaluator over all_of/any_of/not/atomic. Implicit all_of for path+content combo. Auto-exempt .yggdrasil/ paths. Head-limited regex via safeRegexTest (256KB cap) to defend against catastrophic backtracking. any_of suppresses unreadable when any sibling passes (matches spec §7 L694 intent). Plan Task 1.5.
## [2026-05-15T12:28:18.211Z]
R0.4: file-content-cache import path updated from ./file-content-cache to ../io/file-content-cache
