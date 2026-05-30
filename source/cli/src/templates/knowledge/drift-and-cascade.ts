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

Upstream drift occurs when an aspect, parent node, flow, or dependency
changed. The node's context changed even if its own source files didn't.
The reviewer must re-verify the node against the updated context.

Fix: \`yg approve --aspect <id>\` (batch) or \`yg approve --node <path>\`
for each affected node individually.

Causes of upstream drift:
- An aspect's \`content.md\` or \`check.mjs\` is modified.
- A reference file declared in an aspect's \`references:\` is modified — same cascade as content.md change.
- A parent node's aspects change.
- A flow the node participates in changes.
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

A drifted node makes at least one LLM call per effective non-draft LLM aspect
during approve (× the tier's consensus count × the number of prompt chunks).
AST and structure aspects re-verify locally at zero LLM cost, so a node whose
aspects are all AST/structure re-approves with no LLM call.

| Scenario | LLM calls |
|----------|-------|
| Edit one file, approve node | 1 per effective LLM aspect (AST/structure: 0) |
| Add \`implies\` to an aspect | affected nodes × 1 |
| Change aspect \`content.md\` | affected nodes × 1 |
| Add aspect to parent node | all descendants × 1 |
| Add node to a flow | node × flow-aspect-count |

Use \`yg impact\` before every graph change to see the call count.
An aspect touching 20 nodes that each have 3 effective aspects = 60 calls.

### Tier identity is part of the per-node drift hash

Each LLM aspect contributes a \`tier-identity:<aspectId>\` synthetic entry
into the per-node canonical hash. Anything that changes the resolved tier
triggers re-approve on every node using that aspect:

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
