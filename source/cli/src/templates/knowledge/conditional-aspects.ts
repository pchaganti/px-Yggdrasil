export const summary = 'when predicate on aspects: global vs per-attach-site, relation/type/mapping filters, combining AND';

export const content = `# Conditional aspects (when predicate)

The \`when\` predicate on an aspect filters applicability. Every propagation
channel passes through \`when\` before the aspect becomes effective on a node.
If \`when\` is false, the aspect is silently skipped on that node.

## Why use when

Without \`when\`, attaching an aspect to a type or parent node applies it to
every node of that type or every child. That is often too broad.

Examples where \`when\` helps:
- \`external-api-error-mapping\` attached to type \`command\` but only
  applicable when the command calls a service-client
- \`pii-encryption\` on all repositories, but only when they store a
  user-profile field
- \`idempotency-key\` required only for commands that emit events
- \`database-migration-review\` only for nodes with mappings under \`db/migrations/\`

## Declaring when

### Global (on the aspect)

Applies across all channels. Every attach site for this aspect passes through
this filter.

\`\`\`yaml
# aspects/idempotency-key/yg-aspect.yaml
id: idempotency-key
description: Commands that emit events must carry an idempotency key.
when:
  relations:
    emits:
      count_gte: 1
\`\`\`

### Per-attach-site

Declared inline on the aspect reference at the attach point.

\`\`\`yaml
# In yg-node.yaml aspects list:
aspects:
  - id: pii-encryption
    when:
      has_mapping:
        path: "src/profiles/**"
\`\`\`

\`\`\`yaml
# In architecture default_aspects for a type:
default_aspects:
  - id: audit-logging
    when:
      relations:
        calls:
          target_type: payment-service
\`\`\`

## AND combination

Global and per-attach-site \`when\` combine via AND on each channel path.
The aspect is effective on a node if ANY channel's path passes BOTH its
global and its attach-site filter.

## Available when atoms

### relations filter

\`\`\`yaml
when:
  relations:
    calls:
      target_type: service-client   # node calls at least one service-client
    emits:
      count_gte: 1                  # node emits at least one event
\`\`\`

### has_mapping filter

\`\`\`yaml
when:
  has_mapping:
    path: "src/handlers/**"         # node has at least one mapped file under this glob
\`\`\`

### node_type filter

\`\`\`yaml
when:
  node_type: command                # node is of this type
\`\`\`

## Cost

\`when\` evaluation is deterministic — no LLM call. Use \`when\` freely to
narrow applicability. It is cheaper than letting the reviewer decide by
reading code.

## Prefer when over splitting types

When you find yourself wanting to create \`command-with-events\` and
\`command-without-events\` as separate types just to control aspect
applicability, use \`when\` instead. Fewer types, same precision.

## Checking applicability

\`yg context --node <path>\` shows effective aspects with their channel source.
An aspect that appears silently skipped due to \`when\` will not appear in the
effective list — this is correct behavior, not a bug.
`;
