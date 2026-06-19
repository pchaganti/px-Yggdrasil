# Scenario document must match its paired test

Each scenario document under the catalogue is paired 1:1 with an end-to-end
test (its companion, resolved per unit and shown in the `<companions>` block).

Verify that the scenario's reproduction steps faithfully describe what the
paired test actually does:

- Every step the scenario claims the test performs must be present in the test.
- The scenario must not describe behaviour the test does not exercise.
- The scenario `title` must correspond to the test's described intent.

Judge only this scenario against its single paired test. The paired test is
read-only context — do not flag the test itself.
