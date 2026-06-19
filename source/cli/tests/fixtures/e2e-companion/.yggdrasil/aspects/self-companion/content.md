# Scenario document is reviewed on its own (self-companion dedupe)

This aspect ships a companion.mjs that returns the subject document's OWN path.
A returned path equal to a unit subject is NOT injected and NOT recorded as a
companion observation — it is already hashed and rendered as the subject. The
result is no `<companions>` block and no extra touched entry.

Verify the scenario document contains at least one reproduction step.
