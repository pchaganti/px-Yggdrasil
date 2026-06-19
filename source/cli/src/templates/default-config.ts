export const DEFAULT_CONFIG = `version: "5.1.0"

# Quality thresholds
quality:
  max_direct_relations: 10

# Reviewer configuration added by: yg init
# (see yg schemas read config + yg knowledge read configuration)

debug: false
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
