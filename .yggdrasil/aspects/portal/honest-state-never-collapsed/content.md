# Honest state — never collapsed into one "green"

The honesty model is the spine of the portal: it is not a feature, it is the schema of the
page. A view module must keep the distinct verdict states **visually and structurally
distinct** and must **never collapse any of them into one "green."**

"Green" means exactly one thing: **a reviewer actually checked this against the current code
and it passed** — a verdict was approved AND its stored hash still matches the current inputs.
Nothing else is green. Absence of red is not a pass.

Apply this rule to the view file under review: read every place it decides what state to
render, what label or glyph or color-class to attach, and what to put in a counter, a bar
segment, a cell, a summary, or a header. Refuse the file if any of the rules below is broken.

## Rules

- **`verified` is the only green.** A view may render the green/verified treatment only for a
  state that is genuinely `verified`. It must read that treatment from the shared honest-state
  model (`Yg.states` — its `cssClass` / `badge` / `glyph` / `label` / `plain`), never invent a
  green color-class, glyph, or label of its own.

- **`no-rule` is not a pass.** A node (or file) with no effective rule is unguarded, not
  approved. It must render in its own distinct `no-rule` treatment — never green, never blank,
  never silently omitted. "Nothing is checking this" must read as exactly that.

- **`not-applicable` (when-filtered) is not a pass.** A rule filtered out here by a `when`
  predicate is a deliberate empty cell, distinct from `unverified` and from `verified`. It is
  never shown as green and never silently equated with "all clean."

- **`draft` is not a pass and not a failure.** A parked (draft) rule is removed from the
  expected set and verifies nothing. It must render as its own distinct parked state — never
  folded into green, never counted as a pass.

- **`unverified` is not a pass.** When inputs changed, nothing was ever checked, or a fill did
  not complete, the state is `unverified` — "we don't know," not "it's fine." It must render
  distinctly from `verified`, never as green.

- **`advisory` / `warning` is not green.** An advisory rule that flagged something is signal,
  not a clean pass. A refused or unverified advisory pair renders as a warning, never as green.
  Status (draft / advisory / enforced) governs only how a state blocks and renders — it never
  turns a non-verified state green.

- **A `declaredOnly` boundary edge is NOT a violation.** The live boundary has three classes.
  `phantom` (an undeclared code dependency) and `forbiddenType` (a code dependency to an
  architecture-disallowed type) are real violations and render as such. `declaredOnly` (a
  declared relation with no static code backing) is **legitimate by design** — reflection,
  dependency injection, HTTP, and event edges are declared without any static call, and the
  relation-conformance contract never complains about them. A view must render `declaredOnly`
  **neutrally / informationally**, never red, never labeled a violation, never summed into a
  violation count.

- **Surface the UNKNOWN boundary state honestly.** When the live relation parse could not run
  (`boundary.unknown`), the view must render `UNKNOWN — not clean, not zero`, never a
  fabricated green or a fabricated zero from a check it could not run.

- **The absence of red is not a pass, and the coverage fraction has a visible denominator.**
  A view must not present "no failures" as "all verified." Counts derived from the non-pair
  track (no-rule / draft / not-applicable) must stay structurally separate from the
  pair-state counts (verified / refused / unverified) and must never be added into the
  verified total or the coverage fraction.

## Why

A portal that collapses these states into one cheerful green would lie: it would let an
unchecked, unguarded, parked, or merely-not-yet-reviewed surface read as "approved." The whole
trust proposition is that a green on this page means a reviewer actually checked it. Keeping
the states distinct — and keeping `declaredOnly` out of the violation bucket — is what makes
the page honest.
