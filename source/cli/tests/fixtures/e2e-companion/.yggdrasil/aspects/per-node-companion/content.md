# The scenario catalogue must match the spec suite as a whole

This per:node aspect reviews the entire scenario catalogue at once. Its
companion.mjs resolves every scenario's paired spec, so the single prompt
carries all scenarios (subject) plus the union of paired specs (companions).

Verify that, taken together, the scenarios cover the spec suite consistently:
each scenario names a spec that exists, and the steps line up.
