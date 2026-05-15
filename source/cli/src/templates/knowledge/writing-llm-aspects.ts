export const summary = 'How to write content.md for LLM reviewer: rule structure, what/why/how, common pitfalls';

export const content = `# Writing LLM aspects

LLM aspects use \`reviewer: llm\` (the default) and ship a \`content.md\`
describing the rules in prose. The reviewer receives \`content.md\` + all
source files of the node and returns approved or refused.

## Structure of content.md

A good \`content.md\` answers three questions per rule:
1. **WHAT** must be true in the code
2. **WHY** — the business or architectural reason
3. **HOW** — what a passing implementation looks like (example optional)

\`\`\`markdown
# Audit Logging

Every public method that mutates state must emit an audit log entry
before returning.

## Why

Regulatory requirement: all state changes must be traceable for 7 years.
Missing an audit entry for any mutation violates compliance.

## What a passing implementation looks like

\`\`\`typescript
async function updateUser(id: string, data: UserData): Promise<User> {
  await auditLog.emit({ action: 'user.update', id, actor: ctx.userId });
  return this.repo.update(id, data);
}
\`\`\`

Calling \`auditLog.emit\` with \`action\`, \`id\`, and \`actor\` is sufficient.
\`\`\`

## Rules for writing rules

**State what must be true, not what should be avoided.** "Every mutation
must log" is stronger than "don't forget to log". The reviewer checks
whether the positive constraint holds.

**One rule per heading.** Mixing multiple constraints in one paragraph
causes the reviewer to miss violations or produce inconsistent judgments.

**Never invent rationale.** If you don't know why a rule exists, ask. The
reviewer surfaces the rule's reason to the developer who must comply. Wrong
rationale = wrong fix guidance.

**Be specific about scope.** "Every function" is too broad. "Every public
method that mutates state" is precise enough for the reviewer to distinguish
violating from non-violating code.

## Content.md does not replace aspects

Do not put cross-cutting rules inside a single node's \`content.md\`. If the
same rule applies across many nodes, extract it into a shared aspect and
attach it to those nodes. A rule buried in one node's prose never reaches
the others.

## Reviewer behavior

The reviewer approves or refuses — no partial approval. If any rule fails,
the whole aspect fails for that node. The reviewer explains what and where.

You iterate: fix the code, re-run \`yg approve --node <path>\`. Log entries
are needed only once per approve cycle — adding one before the first attempt
covers all retries until approve succeeds.

## When to prefer AST over LLM

If the rule is expressible as "this identifier must / must not appear" or
"imports from X are forbidden in Y" — use an AST aspect instead. AST is
deterministic, free to run, and produces no false positives. LLM is better
for semantic rules that require reading the code's meaning.

## Pitfalls

- **Vague rules**: "Handle errors properly" → reviewer doesn't know what
  "properly" means. Be explicit: "Every async function must \`await\` promises
  and propagate errors to the caller."
- **Overlapping aspects**: Two aspects saying similar things cause double
  reviewer calls and confused violation messages. Consolidate first.
- **Rule too strict**: "Every file must have a JSDoc comment" will reject
  any file without JSDoc, even if comments are unnecessary. Scope the rule
  correctly.
`;
