export const summary = 'Flow definition — a business process with node participants and propagated aspects.';

export const content = `# yg-flow.yaml — Schema for end-to-end business flows
# Each flow is a directory under .yggdrasil/flows/ containing this file.
#
# A flow describes a business process — what happens in the world,
# not code call sequences. "User places an order" is a flow.
# "Handler calls service" is a relation between nodes.
#
# Descendants of a declared participant are automatically included —
# listing a parent node covers all its children.

name: EndToEndProcessName     # required — display name
description: "What this business process does"  # required — shown in yg flows output and
                                                # context packages. Validator emits description-missing if absent.

nodes:                        # required, non-empty — participant nodes (alias: participants)
  - orders/order-service      # paths relative to model/
  - payments/payment-service  # each participant (and its descendants) must satisfy
  - inventory/inventory-service  # any flow-level aspects declared below

aspects:                      # optional — aspects propagate to all flow participants (channel 5)
  - simple-aspect             #   bare string
  - id: conditional-aspect    #   object form with per-site applicability filter
    status: enforced          #   optional — explicit status override (channel 5).
                              #   Must satisfy bump rule (bump up OK, downgrade is validator error).
    when: <predicate>         #   optional — see yg schemas read aspect for grammar
`;
