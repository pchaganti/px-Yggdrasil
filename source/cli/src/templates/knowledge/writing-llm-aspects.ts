export const summary =
  'How to write content.md for the LLM reviewer: rule structure, scope (per-file is file-local only), prompt limits, false-positive path with aspect-test as the sanctioned diagnostic';

export const content = `# Writing LLM aspects

LLM aspects ship a \`content.md\` describing the rules in prose. The reviewer
receives \`content.md\` + any reference files + the unit's subject files and
returns approved or refused. The verdict is cached in the lock keyed by the
\`(aspect, unit)\` pair.

## content.md format

A \`content.md\` file is a Markdown document with:
- A top-level heading naming the aspect
- One H2 section per rule
- Each section answers: WHAT must be true, WHY it matters, HOW a passing
  implementation looks

\`\`\`markdown
# Aspect Name

Brief one-sentence description of the aspect's purpose.

## Rule: Emit audit log before mutation

Every public method that mutates state must emit an audit log entry
before returning.

### Why

Regulatory requirement: all state changes must be traceable for 7 years.

### What passing looks like

\`\`\`typescript
async function updateUser(id: string, data: UserData): Promise<User> {
  await auditLog.emit({ action: 'user.update', id, actor: ctx.userId });
  return this.repo.update(id, data);
}
\`\`\`
\`\`\`

## Writing the rules

Rules are the heart of the aspect. Write them so a reviewer can make a
binary pass/fail decision by reading the code.

**One rule per heading.** Mixing multiple constraints in one paragraph
causes the reviewer to miss violations or produce inconsistent judgments.

**State what must be true, not what should be avoided.** "Every mutation
must log" is stronger than "don't forget to log". The reviewer checks
whether the positive constraint holds.

**Be specific about scope.** "Every function" is too broad. "Every public
method that mutates state" is precise enough for the reviewer to distinguish
violating from non-violating code.

**Never invent rationale.** If you don't know why a rule exists, ask. The
reviewer surfaces the rule's reason to the developer who must comply. Wrong
rationale = wrong fix guidance.

**Do not put cross-cutting rules in one node's content.md.** If the same
rule applies across many nodes, extract it into a shared aspect and
attach it to those nodes. A rule buried in one node's prose never reaches
the others.

## Choosing scope: per node vs per file

An aspect declares \`scope.per: node\` (default) or \`scope.per: file\`, optionally
narrowed by \`scope.files\`.

\`per: file\` is correct ONLY for **file-local rules** — ones a reviewer can judge
from a single file alone ("every handler validates its input"). Rules that need
cross-file context — "correlation ID propagates across calls", "exactly one file
exports X" — must stay \`per: node\`. A per-file reviewer cannot see the rest of
the node and will produce false verdicts in both directions, silently. Cross-file
rules against a **static shared contract** can use \`per: file\` + \`references:\`
(the contract travels in every prompt).

**Pre-flight ritual before switching an aspect to \`per: file\`:** generate one
per-file prompt and read it —

\`\`\`bash
yg aspect-test --aspect <id> --node <representative> --dry-run
\`\`\`

If the rule cannot be judged from that single file plus references, it is not
file-local; leave it \`per: node\`. This guidance is load-bearing and cannot be
enforced deterministically.

A \`scope\` edit (either \`per\` or \`files\`) invalidates EVERY pair of the aspect —
it cascades like a \`content.md\` edit. Narrowing \`scope.files\` to exclude tests
is still a full re-verification. Run \`yg impact --aspect <id>\` first.

## Cost considerations

Each effective non-draft LLM pair = at least one reviewer call during
\`yg check --approve\`, multiplied by the tier's consensus count. With \`per: file\`,
multiply again by the subject-file count, and references are loaded into every
per-file prompt. Deterministic aspects cost ZERO LLM calls. Draft aspects produce
no pairs (zero cost, no verdict).

Before creating a new LLM aspect:
1. Check if an existing aspect covers the rule (\`yg aspects\`)
2. Run \`yg impact --aspect <id>\` on similar existing aspects to understand
   the scale of review calls this will generate
3. Consider whether a deterministic aspect would serve the same purpose for free

When an aspect touches many pairs, verification is expensive. Prefer narrow,
precise aspects over broad catch-all ones.

## Prompt-size gate

Each tier may set \`max_prompt_chars\`. An assembled LLM prompt (scaffold +
content.md + references + subject files + node descriptor) exceeding the resolved
tier's limit is a blocking \`prompt-too-large\` error — checked deterministically
at \`yg check\`, and the pair is skipped by \`--approve\`. Remedies, in safety order:

1. Narrow \`scope.files\` — safe when the overflow is non-target payload (fixtures,
   generated files, docs).
2. Switch the aspect to \`per: file\` — ONLY if the rule is file-local (above).
3. Split the node.
4. Raise the limit or move the aspect to a higher-limit tier — a tier edit
   cascades re-verification across every aspect resolving to that tier; confirm
   with the user.

## False-positive mitigation

LLM reviewers can produce false positives: refusing code that is actually
correct. Causes:
- Rules stated ambiguously — reviewer interprets differently than intended
- Rules that are too strict — no room for valid alternative implementations
- Rules that conflict with each other within the same aspect

To reduce false positives:
- Include "what passing looks like" examples in each rule section
- Include "what a false positive looks like" notes when ambiguity is known
- Preview the prompt with \`yg aspect-test --aspect <id> --node <path> --dry-run\`
- If a reviewer consistently refuses correct code, sharpen the rule text —
  knowing this re-verifies EVERY node using the aspect (run \`yg impact --aspect\`
  first).

A refusal in the lock is cached and final for unchanged inputs — re-running
\`yg check --approve\` re-renders it, it does not re-roll. When you believe a
refusal is a false positive, \`yg aspect-test\` is the sanctioned diagnostic: it
runs the reviewer live WITHOUT writing the lock.

\`\`\`bash
yg aspect-test --aspect <id> --node <path>
\`\`\`

If aspect-test repeatedly approves what the lock refuses, the rule text is
ambiguous for this reviewer. Two sanctioned exits: sharpen \`content.md\`
(cascades — check \`yg impact\`), or propose a \`yg-suppress\` to the user. There is
deliberately no verdict-drop command, and a cosmetic edit purely to force a
re-roll is forbidden laundering.

When a reviewer refuses code you believe is correct:
1. Read the refusal carefully — it tells you exactly what rule it applied
2. If the code is correct and the rule is wrong, update the rule text (cascades)
3. If the rule is right and the code needs changing, fix the code
4. Use \`yg-suppress\` only for intentional, documented exceptions with user approval

## Choosing a reviewer tier

LLM aspects may opt into a specific reviewer tier from \`yg-config.yaml\`:

\`\`\`yaml
# .yggdrasil/aspects/test-quality/yg-aspect.yaml
name: TestQuality
description: Tests verify correct behavior, not just coverage.
reviewer:
  type: llm
  tier: deep        # one of the keys under reviewer.tiers in yg-config.yaml
\`\`\`

When \`tier:\` is omitted, the aspect uses the tier named by \`reviewer.default\`
(or the sole tier, if only one is configured).

Use a higher-capability tier (e.g. \`deep\`) when the aspect interprets nuanced
semantics, a false approval is much more costly than the higher per-call price,
or the rules are ambiguous enough that a cheaper model gives flaky judgments. Use
the cheaper default tier for narrow, well-defined contracts.

The resolved tier identity is folded into every LLM pair's hash: changing
\`reviewer.tier:\` on an aspect, or editing the referenced tier's
\`provider\`/\`consensus\`/\`config\`, invalidates every pair using it and re-verifies
on the next \`yg check --approve\`. Run \`yg impact --aspect <id>\` before swapping
a tier on a widely-used aspect.

## When to prefer a deterministic aspect over LLM

If the rule is expressible as "this identifier must / must not appear" or
"imports from X are forbidden in Y" — use a deterministic aspect instead. It is
deterministic, produces no false positives, and costs nothing per call.

## Reference files

An LLM aspect may declare \`references:\` in yg-aspect.yaml — supporting
files (lookup tables, catalogues, contracts) loaded into the reviewer
prompt alongside content.md. References answer questions like "what's the
exact list of valid error codes?" without requiring content.md to embed
data that lives elsewhere.

### When to use references

Use when the rule depends on data that:
- Lives outside the aspect (catalogue, enum, ID list).
- Changes independently of the rule itself.
- Would otherwise force the author to either duplicate it into content.md
  or describe it abstractly and hope the reviewer infers correctly.

Do NOT use references for:
- The rule statement itself — that's content.md.
- Source code under review — that comes from the node's mapping.
- Ambient project context — that belongs in rules / knowledge files.

### Format

\`\`\`yaml
references:
  - docs/error-codes.md                            # shorthand string
  - path: source/cli/src/errors/codes.ts           # explicit form with description
    description: "Source of truth for error code constants."
\`\`\`

Two equivalent entry forms. The description (when present) helps both the agent
and the reviewer understand the reference's role, and it is folded into the LLM
pair's hash — editing it re-verifies.

### Composition with implies

References attach to the aspect's effective presence on a node. Each
aspect is reviewed independently — A's prompt does NOT contain B's
references, even when A implies B. If A's content.md says "see catalogue
in B", declare the same reference on A or move it onto A directly.

### Composition with when

If an aspect has a \`when\` predicate that filters it out on a particular node,
its references are also filtered out on that node — references attach to the
aspect's effective presence, not its declaration.

### Cost

Editing a referenced file invalidates every pair where the referring aspect is
effective. Run \`yg impact --file <ref>\` before editing a widely-referenced file.
A reference's bytes count toward the prompt-size gate — there is no separate
reference byte cap; the prompt limit bounds the whole payload.

## Aspect status

LLM aspects declare \`status: draft | advisory | enforced\` (default \`enforced\`).
Status is rendering only. Draft produces no pairs (zero cost). Advisory and
enforced both verify; they differ only in how a refused or unverified pair
renders. See: \`yg knowledge read aspect-status\`.
`;
