export const summary = 'What aspects are, 7 propagation channels, how to discover patterns, LLM vs AST reviewer choice';

export const content = `# Aspects overview

Aspects are enforceable rules attached to nodes. A reviewer (LLM or AST)
checks every source file of a node against every effective aspect.

## What an aspect is

An aspect pairs a description (\`content.md\` for LLM, \`check.mjs\` for AST)
with metadata (\`yg-aspect.yaml\`). When you run \`yg approve --node <path>\`,
the reviewer receives the aspect description and all source files of the node,
then returns approved or refused with a violation report.

## When to create an aspect

Create an aspect when:
1. The same pattern appears in 3+ files AND
2. A reviewer can verify it against source code

Both conditions must hold. "Code should be readable" fails condition 2.
"Every handler must log an audit trail" satisfies both.

## 7 propagation channels

Every node accumulates aspects from 7 sources simultaneously:

| Channel | Source |
|---------|--------|
| 1. Own | \`node.aspects\` in \`yg-node.yaml\` |
| 2. Ancestor | Parent node's aspects cascade to all children |
| 3. Own type | Architecture default aspects for the node's type |
| 4. Ancestor type | Default aspects for parent's type |
| 5. Flows | Flow-level aspects apply to all participants |
| 6. Ports | Consumed port's aspects become effective on consumer |
| 7. Implied | \`implies: [other-aspect]\` chains expand recursively |

The reviewer checks ALL channels. A node must satisfy every effective aspect
regardless of origin.

## Discovering aspects in brownfield code

Signs that an aspect should exist:
- Same utility called in 3+ files
- Same comment repeated across files ("must not call X directly")
- Same pattern enforced in code review across multiple PRs
- Cross-cutting concerns: auth guards, audit logging, webhook dispatch

## LLM vs AST reviewer

**Choose LLM (\`reviewer: llm\`, default) when:**
- The rule requires judgment ("no business logic in controllers")
- The rule involves semantics ("correlation ID must propagate across calls")
- The rule is hard to express as a syntax pattern

**Choose AST (\`reviewer: ast\`) when:**
- The rule is structural ("never import from \`db/\` in \`ui/\`")
- The rule is naming-based ("exported classes must be PascalCase")
- You need zero false-positive tolerance and determinism
- The rule is "X must never appear" — forbidden API calls, banned imports

AST aspects run synchronously with no LLM call; they are free to run
and produce exact results. Use them whenever the rule is expressible
in syntax terms.

## Aspect files

\`\`\`
aspects/<id>/
  yg-aspect.yaml    ← id, description, implies, reviewer type
  content.md        ← LLM reviewer: rule description (prose)
  check.mjs         ← AST reviewer: check function (JavaScript)
\`\`\`

Exactly one of \`content.md\` or \`check.mjs\` is allowed per aspect.

## Implies chains

\`\`\`yaml
# aspects/audit-logging/yg-aspect.yaml
implies:
  - diagnostic-logging
\`\`\`

When \`audit-logging\` is effective on a node, \`diagnostic-logging\` is also
effective (channel 7). Chains expand recursively. Cycles are forbidden —
\`yg check\` detects them.

## Cost model

Every effective aspect on a node = one reviewer call during \`yg approve\`.
A node with 5 aspects = 5 LLM calls. An aspect touching 20 nodes = 20 calls
when you run \`yg approve --aspect <id>\`.

Use \`yg impact --aspect <id>\` before creating or modifying a widely-used
aspect to assess the re-approval cost.
`;
