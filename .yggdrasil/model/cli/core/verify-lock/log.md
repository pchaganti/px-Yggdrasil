## [2026-06-13T03:12:07.502Z]
Checking is a pure recomputation: each stored verdict is valid only while the exact inputs it was judged against still hash to the recorded value, so verification re-derives that hash from current source, rule text, references, tier identity and recorded observations and compares — it never re-runs the reviewer and never writes.
