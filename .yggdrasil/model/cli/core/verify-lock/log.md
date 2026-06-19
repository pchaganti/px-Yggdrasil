## [2026-06-13T03:12:07.502Z]
Checking is a pure recomputation: each stored verdict is valid only while the exact inputs it was judged against still hash to the recorded value, so verification re-derives that hash from current source, rule text, references, tier identity and recorded observations and compares — it never re-runs the reviewer and never writes.
## [2026-06-13T05:33:44.743Z]
The deterministic verifier now records and re-checks the result of every probe a check makes beyond its own subject files — directory listings, negative existence checks, graph-set membership, and sibling reads. The recorded observation carries the actual result that was seen, so a cached pass cannot survive a change to anything the check actually observed, only to its own subject files. This closes the gap where a check could read a directory or test for a sibling's existence, pass, and then keep passing after that surrounding state changed.
## [2026-06-16T09:52:38.687Z]
Updated the verdict-hash recompute to fold only the tier NAME, matching the new contract where the reviewer configuration behind a named tier is not a judgment input.
## [2026-06-19T19:19:17.689Z]
Reproduce the paired-review identity on the read-only verification side without re-running the resolver: re-observe the recorded companion reads and re-fold the resolver fingerprint, so an unchanged paired review reads back as verified and editing the paired file or the resolver invalidates it, mirroring how deterministic verdicts are re-checked.
