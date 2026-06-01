export const summary = 'Source drift vs upstream cascade, approve workflow, batch strategies, cost multiplier warning';

export const content = `# Drift and cascade

Drift means the reviewer has not seen the current state of a node's code
or context. \`yg check\` detects drift and blocks CI until re-approved.

## Source drift

Source drift occurs when mapped source files were modified since the last
\`yg approve\`. The node's code changed — the reviewer must verify again.

Detection: \`yg check\` computes a hash of all mapped files and compares
to the approved baseline. Any modification (even whitespace) causes drift.

Fix: \`yg approve --node <path>\`

## Upstream drift

Upstream drift occurs when an aspect, parent node, or dependency changed,
or when a flow the node participates in changes its aspect or participant
set. The node's context changed even if its own source files didn't.
The reviewer must re-verify the node against the updated context.

Fix: \`yg approve --aspect <id>\` (batch) or \`yg approve --node <path>\`
for each affected node individually.

Causes of upstream drift:
- An aspect's \`content.md\` or \`check.mjs\` is modified.
- A reference file declared in an aspect's \`references:\` is modified — same cascade as content.md change.
- A parent node's aspects change.
- A flow the node participates in changes its aspect set (adding/removing a flow aspect, surfacing via that aspect) or its participant set (adding/removing the node as a participant, recomputing the node's effective aspects). A cosmetic edit to the flow file — e.g. its \`description:\` — does not cascade.
- A dependency the node consumes changes.

Upstream drift is also called cascade because a single upstream change
can cascade to many nodes:

\`\`\`
[content drift]    aspect "audit-logging" content.md changes
                     → 20 nodes have this aspect effective
                     → all 20 nodes enter upstream drift state
                     → 20 separate LLM calls required to re-approve

[reference drift]  aspect "error-codes" reference file docs/codes.md changes
                     → 5 nodes have this aspect effective
                     → all 5 nodes enter upstream drift state (cause: docs/codes.md)
                     → 5 separate LLM calls required to re-approve
\`\`\`

In \`yg check\` output each drifted node shows the upstream cause: the
specific file that changed (whether it is content.md, check.mjs, or a
declared reference file). Use this to distinguish a rule change from a
reference-data update before deciding whether to batch or re-approve
individually.

## Cascade scope

Before changing a widely-used aspect, run \`yg impact --aspect <id>\` to
see how many nodes will need re-approval. This is the cascade scope.

Cascade scope examples:
- Aspect used by 3 nodes: low cost, safe to change freely
- Aspect used by 20 nodes: assess whether the change is necessary
- Architecture default aspect on a type with 15 nodes: 15 calls minimum

When cascade scope is high:
1. Consider whether the change can be narrowed (use \`when\` to limit)
2. Batch the approve: \`yg approve --aspect <id>\` runs all at once
3. Use \`--dry-run\` to preview what the reviewer will see before committing

## Cost

A re-approval re-verifies ONLY the aspects whose dependency actually changed and
carries the rest forward. A SOURCE change is node-global — every effective
non-draft aspect re-runs (each LLM aspect = one LLM call × the tier's consensus
count × the number of prompt chunks). An aspect-only cascade — a change to one
aspect's content / metadata / reference file — re-runs just that one aspect; the
node's other aspects keep their prior verdict (no LLM call). Deterministic
aspects re-verify locally at zero LLM cost, so a node whose aspects are all
deterministic re-approves with no LLM call.

| Scenario | LLM calls |
|----------|-------|
| Edit one file, approve node | 1 per effective LLM aspect (deterministic: 0) |
| Add \`implies\` to an aspect | affected nodes × 1 |
| Change aspect \`content.md\` | affected nodes × 1 |
| Add aspect to parent node | all descendants × 1 |
| Add node to a flow (or add an aspect to a flow) | node × flow-aspect-count |

Use \`yg impact\` before every graph change to see the call count.
An aspect touching 20 nodes that each have 3 effective aspects = 60 calls.

### What the baseline records

The per-node baseline stores the hashes of the node's real source and graph
files, a typed \`identity\` block holding the node's upstream identity (its own
aspect-relevant metadata, a per-aspect identity for every effective aspect, and
per-dependency port-aspect hashes), and a per-aspect verdict map recording the
reviewer's last judgment for each non-draft aspect. The canonical drift hash is
computed over the real-file hashes together with that typed identity, so any
upstream identity change cascades exactly like a source change.

Aspect \`status\` is deliberately NOT part of the identity: flipping an aspect
between \`advisory\` and \`enforced\` does not drift the node (the recorded verdict
carries forward) — it only changes how that verdict renders. A \`draft\` ↔
non-draft transition is surfaced separately as a newly-active aspect, because a
draft aspect has no recorded verdict yet.

### Tier identity is part of the per-node drift hash

Each LLM aspect carries a reviewer-tier identity hash in its per-aspect slice of
the typed \`identity\` block, folded into the per-node canonical hash. Anything
that changes the resolved tier triggers re-approve on every node using that
aspect:

- Editing \`reviewer.tier:\` on the aspect (or removing it to fall back to default).
- Editing \`reviewer.default\` in \`yg-config.yaml\` (cascades to every aspect that
  doesn't pin a tier).
- Editing the referenced tier's \`provider\`, \`consensus\`, or any field of
  its \`config:\` block (api_key is excluded — secret rotation does NOT drift).
- Renaming a tier (the tier name is part of the identity, even if the
  config is byte-equivalent).

Re-approve cost depends on the tier the aspect uses. A change on an aspect
pinned to a high-consensus tier multiplies cost by that consensus value
per affected node. Run \`yg impact --aspect <id>\` to see affected nodes
before swapping the tier on a widely-used aspect.

### Check-touched is part of the per-node drift hash

Each deterministic aspect records, in its per-aspect slice of the typed
\`identity\` block, the set of files its \`check.mjs\` actually read at approve time
(a map of path to content hash). Changing that set — adding or removing a
touched file, or editing a cross-node file the check reads — triggers re-approve
on every node using that aspect, at zero LLM cost.

## Approve workflow

1. Edit source files
2. Add log entry: \`yg log add --node <path> --reason "<justification>"\`
3. Run: \`yg approve --node <path>\`

The change is not done until approve passes. Do not defer approval.

Step 2 is mandatory exactly when the node type has \`log_required: true\`
(the default) AND the node's source files changed since the last approve;
the entry must be newer than the one captured at the last approve. This
gate depends ONLY on the type flag plus a source change — never on aspect
status (draft / advisory / enforced). A cascade-only re-approve (no source
change) needs no new entry.

If the reviewer refuses, iterate on the code. You do not need a new log
entry for each retry — one entry covers all retries within a single approve
cycle until approve succeeds.

## Batch approve

\`\`\`bash
yg approve --node A --node B --node C      # explicit batch
yg approve --aspect audit-logging          # only nodes with cascade drift from this aspect
yg approve --flow order-processing         # only nodes with cascade drift from this flow
yg approve --dry-run --node <path>         # preview without LLM call
\`\`\`

Batch at most 3-5 nodes per invocation when using \`--node\` — the reviewer
loses accuracy with too many files in context. \`--aspect\` and \`--flow\`
automatically batch at their own scope.

## Per-node independent execution

In any batch invocation (\`--node A --node B --node C\`, \`--aspect <id>\`, or
\`--flow <name>\`), each node runs the full approve algorithm independently:

  integrity → format → drift → mandatory → reviewer → commit

One node's failure does NOT abort the others. The CLI lists per-node
results and exits 1 if ANY node failed. On partial failure: fix the
per-node errors and re-run the batch with only the failed nodes.

The final \`commit\` phase advances the baseline (clearing drift) ONLY on a
run with no infrastructure failure. If an LLM aspect cannot be verified —
the reviewer provider is unreachable, returns an error or unparseable
response, or NO reviewer is configured for an effective non-draft LLM
aspect — the node fails closed: approve exits 1 and the \`commit\` phase is
skipped entirely, so NOTHING is written to drift state and the prior
baseline is left fully intact. The drift stays visible and a later
\`yg check\` stays red, rather than carrying the previous verdict forward to
green over code the reviewer never saw. An infrastructure failure is not a
code rejection — fix the configuration or connection (or set the aspect to
\`draft\`), then re-run approve. A pure code refusal, by contrast, DOES
commit a \`refused\` verdict (the node is red via the verdict, with reason).

Do not interrupt \`yg approve\` mid-run — it leaves drift state unrecorded.

## Status and drift

Status is NOT part of the canonical drift hash. The hash is stable across
\`advisory ↔ enforced\` flips. Tier-identity entries are included for every
LLM aspect regardless of status (preserving hash stability when an aspect
is flipped to/from draft).

Transitions:
- \`draft → advisory/enforced\` → drift emitted as \`aspect-newly-active\`
  (missing baseline). Run \`yg approve --node <path>\`.
- \`advisory ↔ enforced\` → not drift, but rendering severity may flip.
- \`advisory/enforced → draft\` → not drift. Stale baseline entries cleared
  lazily on next \`yg approve\` of the node.

See: \`yg knowledge read aspect-status\`.
`;
