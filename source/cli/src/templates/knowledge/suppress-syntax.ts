export const summary = 'yg-suppress inline waiver syntax: single-line, bracket disable/enable, wildcard, file-level placement';

export const content = `# Suppress syntax

\`yg-suppress\` is an inline waiver that tells the reviewer to skip a specific
aspect for a piece of code. Use it for known tech debt or intentional
exceptions — not to silence valid violations you intend to fix.

Authorization rules (when you may write a suppress, who approves the reason)
live in agent-rules.md, section "yg-suppress — Inline Aspect Waiver". This
file documents only the on-the-line syntax.

## When to suppress (briefly)

Appropriate uses:
- Brownfield code: known violation, refactor planned but not now
- Intentional exception: the rule genuinely does not apply here
- Temporary waiver: tracked in a ticket, will be resolved

Inappropriate uses:
- Silencing a violation you haven't understood yet
- Avoiding the work of fixing code that should comply
- Hiding security-relevant violations from the graph

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

The token inside the parentheses is the aspect's PATH — its directory under
\`.yggdrasil/aspects/\` (e.g. \`security/input-validation\`), not an \`id:\`
field (there is none in \`yg-aspect.yaml\`). Use \`yg aspects\` to list aspect
paths. A reason must follow — it is permanent.

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

\`\`\`python
# yg-suppress-disable(legacy-pattern) brownfield, TICKET-789
def legacy_handler(request):
    return repo.update(request.id, request.data)
# yg-suppress-enable(legacy-pattern)
\`\`\`

\`\`\`sql
-- yg-suppress-disable(no-select-star) reporting query batch
SELECT * FROM users;
SELECT * FROM orders;
-- yg-suppress-enable(no-select-star)
\`\`\`

The enable marker must repeat the same aspect path as the disable marker —
only a matching enable closes the range. An enable with no open disable is
ignored, and a disable with no matching enable suppresses through to the end
of the file. The matcher does not raise an error for an unmatched marker, so
keep pairs explicit and review the resulting range yourself.

## Wildcard

\`*\` as the id suppresses ALL aspects (LLM and AST) in the range.

\`\`\`typescript
// yg-suppress-disable(*) generated code, do not edit manually
export const GENERATED_MAPPING = { ... };
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\` — the
wildcard disable covers the entire range regardless of specific enables
within it.

## File-level placement

For generated files where the entire file is exempt, place the marker at
the file level (outside any function or class). At file level, the
contextual scope is the whole file.

## Reason text

The reason text after the aspect-id is permanent. Future maintainers and
agents will read it to understand why the waiver exists. Do not invent
reasons — see the authorization rules in agent-rules.md.

## Effect on approve

The reviewer honors suppress unconditionally. A suppressed line or range
does not generate a violation, even if the code clearly violates the aspect.
The suppression is an explicit human decision recorded in the code.

A suppress marker (single or disable form) must carry a reason — an empty
reason is rejected with a clear error. Beyond that, the token is matched as a
plain string against the aspect path being checked: there is NO validation
that the path names an existing aspect, so a typo simply suppresses nothing
(the marker is inert). Nothing validates that the reason is sufficient.
`;
