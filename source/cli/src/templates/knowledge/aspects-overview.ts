export const summary = 'What aspects are, when to create, LLM vs deterministic vs aggregating reviewer choice, cost model';

export const content = `# Aspects overview

Aspects are enforceable rules attached to nodes. A reviewer (LLM or
deterministic) checks every source file of a node against every effective aspect.

## What an aspect is

An aspect pairs a description (\`content.md\` for LLM, \`check.mjs\` for
deterministic) with metadata (\`yg-aspect.yaml\`), and optionally reference files (LLM aspects only) for supporting context. When you run \`yg approve --node <path>\`,
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

While the rule is still being authored or is unclear, give the aspect
\`status: draft\` — a draft aspect is WIP, so the reviewer never runs on it
and it costs zero.

## Three reviewer kinds

Three reviewer kinds exist: LLM, deterministic, and aggregating. The kind is
**inferred** from which rule source file is present in the aspect directory:
\`content.md\` → LLM; \`check.mjs\` → deterministic; neither file but \`implies:\`
declared → aggregating. The \`reviewer:\` block in \`yg-aspect.yaml\` is optional;
if present, an explicit \`reviewer.type\` must agree with the inferred kind.

### Aggregating aspects

An aggregating aspect ships neither \`content.md\` nor \`check.mjs\`. It exists
purely to bundle other aspects under one named attach point. When an aggregating
aspect is effective on a node, all aspects in its \`implies:\` list are expanded
and verified individually. The aggregate itself has no own reviewer and produces
no own verdict. It never dispatches to an LLM and never runs \`check.mjs\`.

Use aggregating aspects to decompose a multi-rule contract: attach the aggregate
once (per node, per flow, per architecture type) and let each implied child carry
one concrete, independently-verdicted rule. An aspect with neither rule source
and no \`implies:\` is rejected by the validator.

### LLM and deterministic sweet spots

The deterministic reviewer runs \`check.mjs\` locally — it covers both per-file
syntactic rules (single-file style) and cross-node graph-shape rules
(graph-aware style), all in one reviewer. LLM and deterministic each have a
distinct sweet spot.

\`check.mjs\` runs in the main Node process with full privileges — there is no
security sandbox. The graph-aware allow-list (below) is a read *discipline* that
scopes tracked dependencies, not an isolation boundary. Only run aspects you trust.

### When to use LLM

Choose LLM (\`reviewer: { type: llm }\`) when:
- The rule requires judgment ("no business logic in controllers")
- The rule involves semantics ("correlation ID must propagate across calls")
- The rule needs to understand intent rather than syntax
- The rule is hard to express as a structural pattern

LLM reviewers understand context, read prose rules, and can assess whether
code satisfies a nuanced requirement. They are slower and cost per call.

LLM aspects may also declare \`reviewer.tier: <name>\` to opt into a
specific reviewer tier configured in \`yg-config.yaml\` (a higher-capability
model for critical aspects, for example). If \`tier:\` is omitted, the
aspect uses \`reviewer.default\` from the config.

### When to use deterministic

Choose deterministic (\`reviewer: { type: deterministic }\`) when:
- The rule is structural ("never import from \`db/\` in \`ui/\`")
- The rule is naming-based ("exported classes must be PascalCase")
- The rule is about graph or file-system shape ("every command node must have
  a sibling test file"; "every child of an engine node must be of type
  engine-component")
- You need zero false-positive tolerance and determinism
- The rule is "X must never appear" — forbidden API calls, banned imports

Deterministic aspects run synchronously with no LLM call; they are free to run
and produce exact, deterministic results. They come in two styles: a single-file
style that inspects each file's syntax tree, and a graph-aware style that
inspects the node's files, the file system, and the graph topology. Deterministic
aspects do NOT use reviewer tiers — \`reviewer.tier:\` is rejected on
\`reviewer.type: deterministic\` aspects.

### Decision tree

1. Can the rule be expressed as "this syntax pattern must (not) appear" or
   "this graph/file-system shape must hold"?
   → Yes: use deterministic
   → No: continue

2. Does the rule require understanding code intent or business logic?
   → Yes: use LLM

3. Is the rule about naming, import paths, structural shape, or cross-node
   consistency?
   → Yes: use deterministic

4. Does the rule need to assess whether semantics match a requirement?
   → Yes: use LLM

When in doubt: write a draft \`check.mjs\`, test it with \`yg deterministic-test\`.
If it catches real violations without false positives, ship it as deterministic.
If it misses violations that require reading intent, switch to LLM.

To author a \`check.mjs\` (both single-file and graph-aware styles):
\`yg knowledge read writing-deterministic-aspects\`.

## Cost model

Every effective non-draft LLM aspect on a node = at least one reviewer call
during \`yg approve\`, multiplied by the tier's consensus count. The reviewer
always sends the full node in a single prompt — there is no chunking.
Deterministic aspects run locally at zero LLM cost. Aggregating aspects have no
own reviewer call. A node with 5 LLM aspects = at least 5 reviewer calls. An LLM
aspect touching 20 nodes = at least 20 calls when you run
\`yg approve --aspect <id>\`.

Use \`yg impact --aspect <id>\` before creating or modifying a widely-used
aspect to assess the re-approval cost.

Aspect references add to drift cascade — modifying a referenced file re-approves every node where the referring aspect is effective.

For full scenario-by-scenario cost breakdown (edit one file, add implies,
change content.md, add aspect to parent, add node to flow) and batch
approve strategies: \`yg knowledge read drift-and-cascade\`.

## Aspect status

Aspects declare \`status: draft | advisory | enforced\` (default \`enforced\`).
Status controls whether the reviewer runs and how \`yg check\` renders violations.

| Status   | LLM cost per node | Renders as |
|----------|-------------------|------------|
| draft    | 0                 | n/a (skipped)            |
| advisory | full              | warning                  |
| enforced | full              | error (blocks yg check)  |

Status changes rendering, not per-call cost. Advisory and enforced both
invoke the reviewer at the same cost.

Deep reference: \`yg knowledge read aspect-status\`.
`;
