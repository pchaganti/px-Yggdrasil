export const summary = 'yg-suppress inline waiver syntax: single-line, bracket form, wildcard, when to use, who approves';

export const content = `# Suppress syntax

\`yg-suppress\` is an inline waiver that tells the reviewer to skip a specific
aspect for a piece of code. Use it for known tech debt or intentional
exceptions — not to silence valid violations you intend to fix.

## When to suppress

Appropriate uses:
- Brownfield code: known violation, refactor planned but not now
- Intentional exception: the rule genuinely does not apply here
- Temporary waiver: tracked in a ticket, will be resolved

Inappropriate uses:
- Silencing a violation you haven't understood yet
- Avoiding the work of fixing code that should comply
- Hiding security-relevant violations from the graph

You MUST obtain explicit user confirmation before writing any suppress.
Never write a suppress unilaterally — even for obvious tech debt.

## Single-line

The single-line form suppresses the immediately following line only.

\`\`\`typescript
// yg-suppress(security/input-validation) static config, no user input
const TIMEOUT = parseInt(process.env.TIMEOUT_MS);
\`\`\`

\`\`\`python
# yg-suppress(cqrs/single-responsibility) brownfield handler, refactor TICKET-123
def handle_order(request):
\`\`\`

\`\`\`yaml
# yg-suppress(schema/required-description) auto-generated, description added later
name: GeneratedNode
\`\`\`

The aspect id is the aspect's \`id\` field from \`yg-aspect.yaml\`.
Use \`yg aspects\` to list ids. A reason must follow — it is permanent.

## Bracket

The bracket form suppresses all lines between the disable and enable markers.
Use when the exemption spans multiple lines (a function, a class, a block).

\`\`\`typescript
// yg-suppress-disable(audit-logging/emit-before-mutate) legacy path, TICKET-456
function legacyUpdate(id: string) {
  // this entire function body is suppressed
  return repo.update(id, data);
}
// yg-suppress-enable(audit-logging/emit-before-mutate)
\`\`\`

The enable marker must have the same id as the disable marker.
Mismatched enable/disable pairs are reported by \`yg check\`.

## Wildcard

\`*\` as the id suppresses ALL aspects (LLM and AST) in the range.

\`\`\`typescript
// yg-suppress-disable(*) generated code, do not edit manually
export const GENERATED_MAPPING = { ... };
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\` — the wildcard
disable covers the entire range regardless of specific enables within it.

For generated files where the entire file is exempt, place the marker at
the file level (outside any function or class).

## Authorization rule

You MUST obtain explicit user confirmation before writing any suppress.

When proposing a suppress:
1. Show the violation and explain why the code cannot comply now
2. Provide the correct aspect id from graph context
3. Ask the user to provide or approve the reason text
4. Only then write the marker with the user-supplied reason

The reason text is permanent and will be read by future maintainers and
agents to understand why the waiver exists. Do not invent reasons.

## Effect on approve

The reviewer honors suppress unconditionally. A suppressed line or range
does not generate a violation, even if the code clearly violates the aspect.
The suppression is an explicit human decision recorded in the code.

\`yg check\` validates that suppress markers are well-formed (matching ids,
valid aspect references). It does not validate that the reason is sufficient.
`;
