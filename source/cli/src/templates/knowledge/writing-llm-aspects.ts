export const summary = 'How to write content.md for LLM reviewer: rule structure, what/why/how, common pitfalls';

export const content = `# Writing LLM aspects

LLM aspects use \`reviewer: llm\` (the default) and ship a \`content.md\`
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

## When to prefer AST over LLM

If the rule is expressible as "this identifier must / must not appear" or
"imports from X are forbidden in Y" — use an AST aspect instead. AST is
deterministic, produces no false positives, and costs nothing per call.
`;
