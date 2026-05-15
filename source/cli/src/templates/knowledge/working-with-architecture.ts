export const summary = 'How to read yg-architecture.yaml: classifying vs organizational types, when grammar, enforce strict, pitfalls, type-suggest';

export const content = `# Working with the architecture file

The architecture file (\`yg-architecture.yaml\`) defines the project's
type system. Types classify source files via the \`when\` predicate.

## When to read this

You're editing \`yg-architecture.yaml\` and need to understand:
- How types classify files (forward + optional strict backward)
- How to write a \`when\` predicate (path + content atoms, operators)
- When to use \`enforce: strict\` vs forward-only
- Organizational types (no \`when\`, parent-only)

For port-based defense against cross-file evasion (channel 6) — a related
but distinct concern — see \`yg knowledge read ports-and-relations\`.

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

Strict enforcement fires two error codes:
- \`type-strict-orphan\` — file matches \`when\` but is in no mapping
- \`type-strict-misplaced\` — file matches \`when\` but is in a wrong-type mapping

Both are reported alongside \`unmapped-files\` when applicable. They are
distinct symptoms with distinct fixes — no de-duplication.

## Pitfalls

- **Overly broad when**: \`path: "**"\` matches everything. Useful for
  placeholder during migration, dangerous in production strict mode.
- **Forgotten not**: command type without \`not: { path: "**/*.test.ts" }\`
  will reject test files that happen to call command APIs.
  For centralized test directories (e.g. \`tests/\`), exclude with
  \`not: { path: 'tests/**' }\` instead of (or in addition to) the
  per-file \`*.test.ts\` negation.
- **Mixing organizational with classifying parents**: a classifying type's
  parents can include organizational types (they're allowed as parents
  in the hierarchy). Validator imposes no semantic restriction.
- **Narrow content regex**: a content predicate that is too specific may
  fail to match valid files when implementation details change.

## Type-suggest workflow

Use \`yg type-suggest --file <path>\` to verify that a file would be
classified correctly under the defined predicates:

\`\`\`bash
yg type-suggest --file src/orders/handler.ts
\`\`\`

Output shows matching types (✓), closest non-matching types ranked by
predicate satisfaction fraction, or edge-case messages for files inside
\`.yggdrasil/\` or for non-existent files (path-only check).

Run this whenever you add or modify a type's \`when\` predicate and want
to verify that existing files are classified as expected.
`;
