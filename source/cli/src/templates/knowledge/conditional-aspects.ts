export const summary = 'when predicate on aspects vs file classification: two grammars, boolean combinators (all_of/any_of/not), node/relations/descendants atoms, combining via AND';

export const content = `# Conditional aspects (when predicate)

The \`when\` predicate filters applicability. Every propagation channel passes
through \`when\` before an aspect becomes effective on a node. If \`when\` is
false, the aspect is silently skipped on that node — no reviewer call, no cost.

## Two distinct \`when\` grammars

There are TWO predicate grammars. They share the same boolean operator names
(\`all_of\`, \`any_of\`, \`not\`), but their atomic clauses are completely
different — each grammar inspects a different kind of subject. The operators
are interchangeable; the atoms are NOT. Never use an atom from one grammar in
the other.

1. **Aspect-when** — node-level applicability: filters whether an aspect
   applies to a NODE. Used by EVERY aspect attach site: the aspect's own
   \`yg-aspect.yaml\` \`when:\`, \`yg-node.yaml\` aspects and ports,
   \`yg-architecture.yaml\` \`node_types.*.aspects[].when\`, \`yg-flow.yaml\`
   aspects, and \`implies\` edges. Its atoms are \`node\`, \`relations\`, and
   \`descendants\` — they inspect the node's type, ports, mapping, and relations.

2. **File-when** — architecture file classification: decides which source
   FILES belong to a node type. Used ONLY in \`yg-architecture.yaml\`
   \`node_types.*.when\`. Its atoms are \`path\` and \`content\` — they inspect a
   single file's repo-relative path and its text. (Deep dive:
   \`yg knowledge read working-with-architecture\`.)

This document is about aspect-when unless a section is explicitly labelled
file-when.

## Why use when

Without \`when\`, attaching an aspect to a type or parent node applies it to
every node of that type or every descendant. That is often too broad.

Examples where aspect-when helps:
- \`external-api-error-mapping\` attached to a command type, but only when the
  command actually calls a service client.
- \`pii-encryption\` on all repository nodes, but only when the node has a
  mapping (skip organizational parents that own no files).
- \`correlation-tracking\` only on nodes that consume a specific port.

## Aspect-level when grammar

\`\`\`yaml
when:
  all_of: [<clause>, ...]    # AND — every clause must pass
  any_of: [<clause>, ...]    # OR — at least one clause passes
  not: <clause>              # negation of a single clause
  # Or top-level atomic clauses (multiple atoms at the top level imply all_of):
  node:
    type: <type-id>          # node is exactly this type
    has_port: <port-name>    # node declares this named port
    has_mapping: true|false  # node owns at least one mapped file (or owns none)
  relations:
    <relation-type>:         # calls | uses | extends | implements | emits | listens
      target_type: <type-id> # at least one relation of this type targets a node of this type
      target: <node-path>    # ...or targets exactly this node path (relative to model/)
      consumes_port: <port>  # ...or consumes this port on the relation
  descendants:               # same checks, but satisfied by ANY hierarchical descendant
    type: <type-id>
    has_port: <port-name>
    relations: { <relation-type>: { target_type: <type-id> } }
\`\`\`

Rules the parser enforces:
- A relation-type entry must carry a match. \`relations: { emits: {} }\` is
  rejected — give at least one of \`target_type\`, \`target\`, or
  \`consumes_port\`. A relation clause then means "at least one relation of that
  type satisfies the match"; there is no count operator.
- A \`node\`, \`relations\`, or \`descendants\` clause must carry at least one
  inner field; an empty clause is rejected.
- At a single level, use EITHER one boolean operator OR atomic clauses — not
  both, and at most one boolean operator. To combine more, nest another level.

### A node calls a service client

\`\`\`yaml
when:
  relations:
    calls:
      target_type: service-client
\`\`\`

### A node OR any of its descendants calls a service client

OR is expressed with \`any_of\` — NOT by creating separate attach sites:

\`\`\`yaml
when:
  any_of:
    - relations:    { calls: { target_type: service-client } }
    - descendants:  { relations: { calls: { target_type: service-client } } }
\`\`\`

### A command that owns files but is not a generated stub

\`\`\`yaml
when:
  all_of:
    - node: { type: command, has_mapping: true }
    - not:
        node: { has_port: generated }
\`\`\`

### A consumer of a specific port

\`\`\`yaml
when:
  relations:
    calls:
      consumes_port: charge
\`\`\`

## Applicability examples by attach site

**Architecture default applied only to a node type that calls payments:**
\`\`\`yaml
# yg-architecture.yaml, node_types.command.aspects
aspects:
  - id: audit-logging
    when:
      relations:
        calls:
          target: payments/service
\`\`\`

**Aspect-global when (precondition wherever attached):**
\`\`\`yaml
# aspects/idempotency-key/yg-aspect.yaml
when:
  relations:
    emits:
      target_type: event-bus
\`\`\`

**Per-attach-site when on a node:**
\`\`\`yaml
# yg-node.yaml aspects
aspects:
  - id: pii-encryption
    when:
      node: { has_mapping: true }
\`\`\`

## File-when grammar (architecture file classification only)

In \`yg-architecture.yaml\`, \`node_types.*.when\` decides which files a type
owns. Its ONLY atoms are \`path\` and \`content\` — the node/relations/descendants
atoms above are NOT available here.

\`\`\`yaml
node_types:
  command:
    when:
      all_of:
        - path: "src/handlers/**"      # minimatch glob on repo-relative POSIX path
        - content: "export class"      # JavaScript regex tested against file content
\`\`\`

Boolean combinators (\`all_of\`, \`any_of\`, \`not\`) work the same way. A bare
\`path\` plus \`content\` at the top level implies all_of of both atoms.

## Propagation through channels

Aspect-global \`when\` (on the aspect definition) and per-attach-site \`when\`
(on the channel's list entry) combine via AND for each channel path.

The aspect is effective on a node if ANY channel's path passes BOTH its
global and its attach-site filter. Channels deliver independently: if an
aspect is directly attached to a node with no \`when\` (channel 1) AND also
delivered via an ancestor with a \`when\` (channel 2), it is effective from
channel 1 regardless of whether channel 2's filter passes.

\`yg context --node <path>\` shows effective aspects with their channel source.
An aspect silently skipped because \`when\` was false does not appear in the
effective list — that is correct behavior.

## Cost

\`when\` evaluation is deterministic — no LLM call. It runs at \`yg check\` time
and is essentially free. Use it freely to narrow applicability; it is cheaper
than letting the reviewer decide by reading code.

Prefer \`when\` over splitting types (fewer types, same precision). Prefer
\`when\` over leaving applicability decisions inside \`content.md\` prose
(\`when\` is enforced by the graph engine — prose rules can be overlooked by
the reviewer).

## When vs status

Applicability (\`when\` predicate) is distinct from enforcement level
(\`status: draft | advisory | enforced\`). A \`when\` filter determines WHETHER
an aspect reaches a node. Status determines what happens AFTER the aspect
reaches the node (whether the reviewer runs and how violations are rendered).
Both can be declared on the same aspect simultaneously. See:
\`yg knowledge read aspect-status\`.
`;
