export const summary = 'How to write content.md for LLM reviewer: rule structure, what/why/how, common pitfalls';

export const content = `# Writing LLM aspects

LLM aspects declare \`reviewer: { type: llm }\` and ship a \`content.md\`
describing the rules in prose. The reviewer receives \`content.md\` + all
source files of the node and returns approved or refused.

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

## Cost considerations

Every effective aspect on a node = one LLM call during \`yg approve\`.

Before creating a new LLM aspect:
1. Check if an existing aspect covers the rule (\`yg aspects\`)
2. Run \`yg impact --aspect <id>\` on similar existing aspects to understand
   the scale of review calls this will generate
3. Consider whether an AST aspect would serve the same purpose for free

When an aspect touches many nodes, an approve cycle is expensive.
Prefer narrow, precise aspects over broad catch-all ones.

## False-positive mitigation

LLM reviewers can produce false positives: rejecting code that is actually
correct. Causes:
- Rules stated ambiguously — reviewer interprets differently than intended
- Rules that are too strict — no room for valid alternative implementations
- Rules that conflict with each other within the same aspect

To reduce false positives:
- Include "what passing looks like" examples in each rule section
- Include "what a false positive looks like" notes when ambiguity is known
- Test with \`yg approve --dry-run --node <path>\` to preview the prompt
- If a reviewer consistently rejects correct code, sharpen the rule text

When a reviewer refuses code you believe is correct:
1. Read the refusal carefully — it tells you exactly what rule it applied
2. If the code is correct and the rule is wrong, update the rule text
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

When \`tier:\` is omitted, the aspect uses \`reviewer.default\` from the
config (or the single configured tier if there is only one).

Use a higher-capability tier (e.g., \`deep\`) when:

- The aspect interprets nuanced semantics (test quality, security-sensitive
  rules, regulatory contracts).
- A false approval is much more costly than the higher per-call price.
- The rules are ambiguous enough that a cheaper model gives flaky judgments.

Use the cheaper default tier when:

- The aspect checks a narrow, well-defined contract (logging, naming).
- Cost per re-approve matters more than precision at the margin.

Tier identity is part of the per-node drift hash: changing \`reviewer.tier:\`
on an aspect (or editing the referenced tier's config) triggers re-approve
on every node that uses the aspect. Run \`yg impact --aspect <id>\` before
swapping a tier.

## When to prefer AST over LLM

If the rule is expressible as "this identifier must / must not appear" or
"imports from X are forbidden in Y" — use an AST aspect instead. AST is
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

Two equivalent entry forms. Description (when present) helps both the
agent and the reviewer understand the reference's role without opening
the file.

### Composition with implies

References attach to the aspect's effective presence on a node. Each
aspect is reviewed independently — A's prompt does NOT contain B's
references, even when A implies B. If A's content.md says "see catalogue
in B", declare the same reference on A or move it onto A directly.

### Composition with when

If an aspect has a \`when\` predicate that filters it out on a particular node,
its references are also filtered out on that node — references attach to the
aspect's effective presence, not its declaration. A \`when\`-filtered aspect
contributes neither aspect content nor references to the reviewer prompt on
filtered nodes.

### Drift cost

Editing a referenced file cascades to every node where the referring
aspect is effective. Run \`yg impact --file <ref>\` before editing a
widely-referenced file.

### Size limits

Each reviewer tier in yg-config.yaml may declare:

\`\`\`yaml
reviewer:
  tiers:
    standard:
      references:
        max_bytes_per_file: 65536
        max_total_bytes_per_aspect: 262144
\`\`\`

Defaults (when omitted): 64 KiB per file, 256 KiB total per aspect.
Oversized references are rejected by \`yg check\`.

## Aspect status

LLM aspects declare \`status: draft | advisory | enforced\` (default
\`enforced\`) in \`yg-aspect.yaml\`. Status controls whether the reviewer is
invoked and how violations are rendered. Draft aspects cost zero LLM calls
(reviewer is skipped). Advisory and enforced both invoke the reviewer at
full cost but differ in how \`yg check\` renders refused verdicts. See:
\`yg knowledge read aspect-status\`.
`;
