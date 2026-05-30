## [2026-05-29T09:56:03.900Z]
aspect-references integration test updated to match the new check output format from the renderer refactor.
## [2026-05-29T09:57:06.536Z]
Updated hasDrift check in aspect-references-drift integration test. The old check searched for 'Cascade' and 'Drift' (capitalized section headers). The new format uses lowercase labels 'cascade (N)' and 'drift' in the error blocks, so the check was updated to use case-insensitive matching.
## [2026-05-29T10:07:14.310Z]
Aspect-references drift test updated to match the new grouped check output format. Drift detection now uses case-insensitive substring matches for 'cascade' and 'drift'.
## [2026-05-30T14:09:02.217Z]
The per-aspect language declaration was removed from the system. An aspect that ships a parsed-tree check used to carry a `language:` list naming the languages it targeted, and the system validated that list with four dedicated checks. Nothing in the runtime ever read it: the engine already determines each source file's language from its file extension through one shared registry, then loads the matching grammar. The declaration was therefore inert metadata that could silently disagree with what the engine actually parsed — an authoritative-looking field that governed nothing.

This change deletes the field, the validators that policed its shape, and the documentation and tests that described it, and promotes the extension-to-grammar registry to the single authority for matching a file to its parser. The motivation is to remove a confusing mismatch between what an aspect claimed about languages and what the engine did, and to collapse the duplicated extension-knowledge that had drifted into more than one place.

The language a parsed-tree check sees for a given file is now derived solely from that file's extension; an unrecognized extension yields no parsed tree rather than a per-aspect error. The drift identity of a graph-aware structural check is deliberately held stable across this change so existing approvals are not invalidated by metadata that never affected behavior.
