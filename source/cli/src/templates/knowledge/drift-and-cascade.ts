export const summary = 'Source drift vs upstream cascade, approve workflow, batch strategies, cost multiplier warning';

export const content = `# Drift and cascade

Drift means the reviewer has not seen the current state of a node's code.
\`yg check\` detects drift and blocks CI until re-approved.

## Two kinds of drift

### Source drift

Mapped source files were modified since the last \`yg approve\`.

Fix: \`yg approve --node <path>\`

### Upstream drift (cascade)

An aspect, parent node, flow, or dependency changed. The node's context
changed even if its own source files didn't.

Fix: \`yg approve --aspect <id>\` (batch) or approve each affected node individually.

## Why cascade is a cost multiplier

One aspect change can cascade to every node that uses that aspect:

\`\`\`
aspect "audit-logging" changes
  → 20 nodes have this aspect effective
  → 20 nodes enter drift state
  → 20 separate LLM calls to re-approve
\`\`\`

Before changing a widely-used aspect, run \`yg impact --aspect <id>\` to
see how many nodes will need re-approval. Assess the cost first.

## Approve workflow

1. Edit source files
2. Add log entry: \`yg log add --node <path> --reason "<justification>"\`
3. Run: \`yg approve --node <path>\`

The change is not done until approve passes. Do not defer approval.

If the reviewer refuses, iterate on the code. You do not need a new log
entry for each retry — one entry covers all retries within a single approve
cycle until approve succeeds.

## Batch approve strategies

\`\`\`bash
# Single node
yg approve --node billing/handler

# Multiple nodes in one call
yg approve --node billing/handler --node billing/repo

# All nodes affected by an aspect change
yg approve --aspect audit-logging

# All nodes in a flow
yg approve --flow order-processing
\`\`\`

Batch at most 3-5 nodes per invocation when using \`--node\` repeatedly —
the reviewer loses accuracy with too many files. \`--aspect\` and \`--flow\`
batch at their own scope.

## Do not interrupt approve

\`yg approve\` processes each aspect across all source files. Interrupting
leaves drift state unrecorded. Always read the full raw output — never
pipe to \`| head\` or \`| grep\`. The reviewer already ran; the output is
the return on the LLM cost.

## Dry run

\`yg approve --dry-run --node <path>\` previews the reviewer prompt without
making an LLM call. Use to verify the right files and aspects are included
before committing to a real call.

## Check detects drift

\`yg check\` is the unified gate — it detects both source drift and upstream
cascade drift. Run it before every commit. CI blocks on any drift.

When \`yg check\` reports drift, read the output: it tells you which nodes
are drifted and which aspect changed (for cascade). Fix by approving the
reported nodes.
`;
