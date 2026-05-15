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

Upstream drift is also called cascade because a single upstream change
can cascade to many nodes:

\`\`\`
aspect "audit-logging" content.md changes
  → 20 nodes have this aspect effective
  → all 20 nodes enter upstream drift state
  → 20 separate LLM calls required to re-approve
\`\`\`

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

Every drifted node = one LLM call during approve.

| Scenario | Calls |
|----------|-------|
| Edit one file, approve node | 1 per effective aspect |
| Add \`implies\` to an aspect | affected nodes × 1 |
| Change aspect \`content.md\` | affected nodes × 1 |
| Add aspect to parent node | all descendants × 1 |
| Add node to a flow | node × flow-aspect-count |

Use \`yg impact\` before every graph change to see the call count.
An aspect touching 20 nodes that each have 3 effective aspects = 60 calls.

## Approve workflow

1. Edit source files
2. Add log entry: \`yg log add --node <path> --reason "<justification>"\`
3. Run: \`yg approve --node <path>\`

The change is not done until approve passes. Do not defer approval.

If the reviewer refuses, iterate on the code. You do not need a new log
entry for each retry — one entry covers all retries within a single approve
cycle until approve succeeds.

## Batch approve

\`\`\`bash
yg approve --node A --node B --node C      # explicit batch
yg approve --aspect audit-logging          # all nodes with this aspect
yg approve --flow order-processing         # all nodes in this flow
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
`;
