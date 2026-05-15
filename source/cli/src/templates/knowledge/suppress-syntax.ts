export const summary = 'yg-suppress inline waiver syntax: single-line, bracket form, wildcard, when to use, who approves';

export const content = `# Suppress syntax

\`yg-suppress\` is an inline waiver that tells the reviewer to skip a specific
aspect for a piece of code. Use it for known tech debt or intentional
exceptions — not to silence valid violations you intend to fix.

## When to use suppress

Appropriate uses:
- Brownfield code: known violation, refactor planned but not now
- Intentional exception: the rule genuinely does not apply here
- Temporary waiver: tracked in a ticket, will be resolved

Inappropriate uses:
- Silencing a violation you haven't understood yet
- Avoiding the work of fixing code that should comply
- Hiding security-relevant violations

## Syntax

### Single-line suppress

Suppresses the immediately following line.

\`\`\`typescript
// yg-suppress(security/input-validation) static config, no user input
const TIMEOUT = parseInt(process.env.TIMEOUT_MS);
\`\`\`

\`\`\`python
# yg-suppress(cqrs/single-responsibility) brownfield handler, refactor tracked in TICKET-123
def handle_order(request):
\`\`\`

### Bracket form (range)

Suppresses all lines between disable and enable markers.

\`\`\`typescript
// yg-suppress-disable(audit-logging/emit-before-mutate) legacy path, tracked in TICKET-456
function legacyUpdate(id: string) {
  return repo.update(id, data);
}
// yg-suppress-enable(audit-logging/emit-before-mutate)
\`\`\`

### Wildcard

\`*\` as the id suppresses ALL aspects in the range.

\`\`\`typescript
// yg-suppress-disable(*) generated code, do not edit
// ... generated content ...
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\` — the wildcard
disable covers the entire range regardless of specific enables within it.

### File-level

A marker placed at the file level (outside any function or class) applies
to the entire file.

## Aspect path format

The argument to \`yg-suppress\` is the aspect id as it appears in
\`yg-aspect.yaml\`. Use \`yg aspects\` to list aspect ids.

## Authorization rule

You MUST obtain explicit user confirmation before writing any suppress.
Never write a suppress unilaterally — even for obvious tech debt.

When proposing a suppress:
1. Show the violation and the reason the code cannot comply now
2. Provide the correct aspect id from graph context
3. Ask the user to provide or approve the reason text
4. Only then write the marker with the user-supplied reason

The reason text is permanent — it will be read by future maintainers and
agents to understand why the waiver exists.

## Effect on approve

The reviewer honors suppress unconditionally. A suppressed line or range
does not generate a violation, even if the code clearly violates the aspect.
The suppression is an explicit human decision recorded in the code.
`;
