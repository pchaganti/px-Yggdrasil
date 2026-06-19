# Scenario document is reviewed on its own

This aspect ships a companion.mjs that deliberately resolves to no companion
files. The reviewer sees only the subject scenario — there is no `<companions>`
block — yet the aspect still ships a hook, so companionHash folds into the
verdict and editing companion.mjs re-verifies every pair.

Verify the scenario document contains at least one reproduction step.
