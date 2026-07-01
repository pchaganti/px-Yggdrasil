export const DEFAULT_CONFIG = `version: "5.1.0"

# Quality thresholds
quality:
  max_direct_relations: 10

# Coverage — which files must belong to a node.
# Fresh projects start in "require nothing" mode: every unmapped file surfaces as
# a NON-blocking warning (not a blocking error), so your very first \`yg check\` is
# green while you adopt incrementally. Add a path prefix to \`required\` (e.g.
# "src/") to make that area blocking once you start mapping it. NOTE: an ABSENT
# coverage block defaults to requiring the WHOLE repo — this explicit empty list
# is what opts a fresh project into require-nothing.
coverage:
  required: []
  excluded: []

# Reviewer configuration added by: yg init
# (see yg schemas read config + yg knowledge read configuration)

debug: false

auto_approve: false
`;

export const DEFAULT_ARCHITECTURE = `# Define your node types below. Each type may have:
#   description: <string>           — required
#   when: <predicate>               — optional. Types with \`when\` classify files;
#                                     types without \`when\` are organizational (parent-only).
#   aspects: [<aspect-id>...]       — optional. Aspects applied to nodes of this type.
#   enforce: strict                 — optional. Requires \`when\`. Bidirectional enforcement.
#   parents: [<type-id>...]         — optional. Allowed parent types.
#
# Example (commented out):
#
#   service:
#     description: "Backend HTTP service"
#     when:
#       path: "src/services/**/*.ts"
#     aspects: [auth-required]

node_types: {}
`;
