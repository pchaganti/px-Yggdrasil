export const summary =
  'Architecture vocabulary — node types, default aspects, allowed parents/relations, when classifiers.';

export const content = `# yg-architecture.yaml — Schema for architecture constraints
# File: .yggdrasil/yg-architecture.yaml
#
# Defines the project's type system: what kinds of nodes exist, how they can
# relate, and which aspects apply by default. This is the foundation of the
# graph — every node declares a type, and every type must be defined here.
#
# Changes to this file affect the entire graph and should be confirmed with the user.

node_types:
  <type-id>:
    description: <string>                    # required — what this type is for, when to use it.
                                             # absence is a FATAL architecture-invalid error (the whole type system is rejected).

    when: <file-predicate>                   # optional — per-file classification.
                                             # Types WITH \`when\` are file-classifying: every file in
                                             # a node's mapping must satisfy the predicate (forward
                                             # check). Types WITHOUT \`when\` are organizational:
                                             # parent-only nodes — any mapping fires
                                             # type-without-when-with-mapping.
                                             #
                                             # Grammar:
                                             #   path: <glob>                — minimatch glob on repo-relative POSIX path
                                             #   content: <regex>            — JavaScript regex against file content
                                             #   path + content combined     — implicit all_of of both atoms
                                             #   all_of: [<predicate>, ...]  — every child must satisfy
                                             #   any_of: [<predicate>, ...]  — at least one child must satisfy
                                             #   not: <predicate>            — single child negation
                                             #
                                             # See: yg knowledge read working-with-architecture

    enforce: strict                          # optional — bidirectional enforcement.
                                             # Requires \`when\`. Every repo file matching the type's
                                             # \`when\` MUST belong to exactly one node of this type
                                             # (backward scan). A matching file owned by no such node
                                             # emits type-strict-orphan; one owned by a node of a
                                             # different type emits type-strict-misplaced.
                                             # Use only for types where missing the type means missing
                                             # a critical aspect (security, audit, regulatory).

    log_required: <boolean>                  # optional — default false. Enable (true) on types whose
                                             # changes carry business intent worth capturing — domain
                                             # logic, command handlers, persistence adapters. When true,
                                             # a node of this type demands a fresh log entry before
                                             # \`yg check --approve\` whenever its mapped source changed
                                             # since the node's last positive closure. Leave omitted
                                             # (false) for types whose changes carry no business decision
                                             # worth forcing an entry for (e.g. config, types, constants).

    aspects:                                 # optional — aspects automatically applied to every
                                             # node of this type (channel 3). Two forms per entry:
      - <aspect-id>                          #   bare string — unconditional
      - id: <aspect-id>                      #   object form — with per-site applicability filter
        status: enforced                     #   optional — explicit status override (channel 3).
                                             #   Must satisfy bump rule (bump up OK, downgrade is validator error).
        when: <aspect-predicate>             #   optional — see yg schemas read aspect for grammar
                                             # These also cascade to children (channel 4).

    parents: [<type-id>, ...]                # optional — allowed parent node types in the hierarchy.

    relations:                               # optional — allowed relation targets by relation type.
      <relation-type>: [<type-id>, ...]      # calls | uses | extends | implements | emits | listens
`;
