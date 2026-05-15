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

## Aspect-level when grammar

The \`when\` predicate supports the following atoms:

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

### AND combination

Filters at the same level combine with AND. For OR semantics, create
separate attach sites with different \`when\` predicates.

## Applicability examples

**Attach to all repositories, apply only when mapping includes user files:**
\`\`\`yaml
aspects:
  - id: pii-encryption
    when:
      has_mapping:
        path: "src/profiles/**"
\`\`\`

**Apply only to commands that emit events:**
\`\`\`yaml
# aspects/idempotency-key/yg-aspect.yaml
when:
  relations:
    emits:
      count_gte: 1
\`\`\`

**Architecture default — apply only to a specific node type:**
\`\`\`yaml
# In yg-architecture.yaml aspects for type 'command':
aspects:
  - id: audit-logging
    when:
      relations:
        calls:
          target_type: payment-service
\`\`\`

## Propagation through channels

Global \`when\` (on the aspect definition) and per-attach-site \`when\`
(on the aspect reference) combine via AND for each channel path.

The aspect is effective on a node if ANY channel's path passes BOTH
its global and attach-site filter.

Multiple channels deliver independently. Example: if an aspect is both
directly attached to a node (channel 1, no when) AND delivered via
ancestor (channel 2, with when), the aspect is effective on the node
from channel 1 regardless of whether channel 2's when passes.

\`yg context --node <path>\` shows effective aspects with their channel
source. An aspect that is silently skipped due to \`when\` does not appear
in the effective list — this is correct behavior.

## Cost

\`when\` evaluation is deterministic — no LLM call. It runs at \`yg check\`
time and is essentially free. Use \`when\` freely to narrow applicability.
It is cheaper than letting the reviewer decide by reading code.

Prefer \`when\` over splitting types (fewer types, same precision).
Prefer \`when\` over leaving applicability decisions inside \`content.md\`
prose (\`when\` is enforced by the graph engine — prose rules can be
overlooked by the reviewer).
`;
