export const summary = 'What aspects are, 7 propagation channels, how to discover patterns, LLM vs AST reviewer choice';

export const content = `# Aspects overview

Aspects are enforceable rules attached to nodes. A reviewer (LLM or AST)
checks every source file of a node against every effective aspect.

## What an aspect is

An aspect pairs a description (\`content.md\` for LLM, \`check.mjs\` for AST)
with metadata (\`yg-aspect.yaml\`). When you run \`yg approve --node <path>\`,
the reviewer receives the aspect description and all source files of the node,
then returns approved or refused with a violation report.

An aspect is always verified — not just when the code changes, but whenever
any upstream input changes (aspect content, parent node, flow membership).
This cascade is deliberate: the reviewer must confirm compliance with the
current state of every constraint.

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
regardless of origin. Adding an aspect to a parent node applies it to ALL
descendants — check blast radius with \`yg impact --aspect <id>\` first.

## Discovering aspects in brownfield code

Signs that an aspect should exist:
- Same utility called in 3+ files
- Same comment repeated across files ("must not call X directly")
- Same pattern enforced in code review across multiple PRs
- Cross-cutting concerns: auth guards, audit logging, webhook dispatch

Use \`yg aspects\` to see existing aspects — avoid creating duplicates.

## LLM vs AST

Two reviewer types are available. Each has a distinct sweet spot.

## When to use LLM

Choose LLM (\`reviewer: llm\`, default) when:
- The rule requires judgment ("no business logic in controllers")
- The rule involves semantics ("correlation ID must propagate across calls")
- The rule needs to understand intent rather than syntax
- The rule is hard to express as a structural pattern

LLM reviewers understand context, read prose rules, and can assess whether
code satisfies a nuanced requirement. They are slower and cost per call.

## When to use AST

Choose AST (\`reviewer: ast\`) when:
- The rule is structural ("never import from \`db/\` in \`ui/\`")
- The rule is naming-based ("exported classes must be PascalCase")
- You need zero false-positive tolerance and determinism
- The rule is "X must never appear" — forbidden API calls, banned imports

AST aspects run synchronously with no LLM call; they are free to run
and produce exact, deterministic results.

## Decision tree

1. Can the rule be expressed as "this syntax pattern must (not) appear"?
   → Yes: use AST
   → No: continue

2. Does the rule require understanding code intent or business logic?
   → Yes: use LLM

3. Is the rule about naming, import paths, or structural shape?
   → Yes: use AST

4. Does the rule need to assess whether semantics match a requirement?
   → Yes: use LLM

When in doubt: write a draft \`check.mjs\`, test it with \`yg ast-test\`.
If it catches real violations without false positives, ship it as AST.
If it misses violations that require reading intent, switch to LLM.

## Cost model

Every effective aspect on a node = one reviewer call during \`yg approve\`.
A node with 5 aspects = 5 reviewer calls. An aspect touching 20 nodes = 20
calls when you run \`yg approve --aspect <id>\`.

Use \`yg impact --aspect <id>\` before creating or modifying a widely-used
aspect to assess the re-approval cost.
`;
