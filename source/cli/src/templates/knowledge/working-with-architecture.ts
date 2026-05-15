export const summary = 'How to read yg-architecture.yaml, type selection, when grammar deep dive, enforce strict, organizational types';

export const content = `# Working with the architecture file

The architecture file (\`yg-architecture.yaml\`) defines the project's
type system. Types classify source files via the \`when\` predicate.

## When to read this

You're editing \`yg-architecture.yaml\` and need to understand:
- How types classify files (forward + optional strict backward)
- How to write a \`when\` predicate (path + content atoms, operators)
- When to use \`enforce: strict\` vs forward-only
- Organizational types (no \`when\`, parent-only)

## Type kinds

Two kinds of types coexist:

1. **Classifying types** — have \`when\`. Files in mappings of nodes of this
   type must satisfy \`when\` (forward). With \`enforce: strict\`, every file
   in repo matching \`when\` must be in a mapping of this type (backward).

2. **Organizational types** — no \`when\`. Used as parent-only in the
   hierarchy. Nodes of this type cannot have non-empty \`mapping:\`.

## Predicate grammar

### path atom
\`\`\`yaml
when:
  path: "src/cli/**/*.ts"
\`\`\`

Matches files whose repo-relative path matches the glob.

### content atom
\`\`\`yaml
when:
  content: "register[A-Z]\\\\w*Command"
\`\`\`

Matches files whose content satisfies the regex.

### Combining: all_of, any_of, not
\`\`\`yaml
when:
  all_of:
    - path: "src/cli/**/*.ts"
    - content: "register[A-Z]\\\\w*Command"
    - not:
        path: "**/*.test.ts"
\`\`\`

## When to use enforce: strict

Use \`enforce: strict\` for types carrying critical aspects (security,
auditing, etc) where missing the type means missing the aspect. Strict
guarantees: every file matching \`when\` must be in a mapping of this
type. Closes the type-shopping evasion entirely for the type.

Don't use \`enforce: strict\` when the \`when\` predicate is broad (e.g.
\`path: "**"\`) — every repo file would be required in that type's mapping.

## Pitfalls

- **Overly broad when**: \`path: "**"\` matches everything. Useful for
  placeholder during migration, dangerous in production strict mode.
- **Forgotten not**: command type without \`not: { path: "**/*.test.ts" }\`
  will reject test files that happen to call command APIs.
`;
