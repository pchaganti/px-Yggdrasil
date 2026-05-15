export const summary = 'What aspects are, when to create, LLM vs AST reviewer choice, cost model';

export const content = `# Aspects overview

Aspects are enforceable rules attached to nodes. A reviewer (LLM or AST)
checks every source file of a node against every effective aspect.

## What an aspect is

An aspect pairs a description (\`content.md\` for LLM, \`check.mjs\` for AST)
with metadata (\`yg-aspect.yaml\`). When you run \`yg approve --node <path>\`,
the reviewer receives the aspect description and all source files of the
node, then returns approved or refused with a violation report.

An aspect is always verified — not just when the code changes, but whenever
any upstream input changes (aspect content, parent node, flow membership).
This cascade is deliberate: the reviewer must confirm compliance with the
current state of every constraint.

For HOW aspects reach a node (the 7 propagation channels with concrete
example), see the SYSTEM section of agent-rules.md — that mental model is
loaded by default and is not duplicated here.

## When to create an aspect

Create an aspect when:
1. The same pattern appears in 3+ files AND
2. A reviewer can verify it against source code

Both conditions must hold. "Code should be readable" fails condition 2.
"Every handler must log an audit trail" satisfies both.

See agent-rules.md "Aspect Discovery" for the brownfield triggers
(repeated patterns, "invisible" cross-cutting concerns) — also not
duplicated here.

## LLM vs AST

Two reviewer types are available. Each has a distinct sweet spot.

### When to use LLM

Choose LLM (\`reviewer: llm\`, default) when:
- The rule requires judgment ("no business logic in controllers")
- The rule involves semantics ("correlation ID must propagate across calls")
- The rule needs to understand intent rather than syntax
- The rule is hard to express as a structural pattern

LLM reviewers understand context, read prose rules, and can assess whether
code satisfies a nuanced requirement. They are slower and cost per call.

### When to use AST

Choose AST (\`reviewer: ast\`) when:
- The rule is structural ("never import from \`db/\` in \`ui/\`")
- The rule is naming-based ("exported classes must be PascalCase")
- You need zero false-positive tolerance and determinism
- The rule is "X must never appear" — forbidden API calls, banned imports

AST aspects run synchronously with no LLM call; they are free to run
and produce exact, deterministic results.

### Decision tree

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

For full scenario-by-scenario cost breakdown (edit one file, add implies,
change content.md, add aspect to parent, add node to flow) and batch
approve strategies: \`yg knowledge read drift-and-cascade\`.
`;
