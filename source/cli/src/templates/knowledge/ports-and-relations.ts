export const summary = 'Six relation types, paired events, ports propagate aspects via channel 6, defense against cross-file evasion, missing-contract warnings';

export const content = `# Ports and relations

Relations express typed dependencies between nodes. Ports propagate aspects
across those dependencies — that is channel 6 of the seven aspect channels.

Mental model: bare relations connect nodes but do NOT carry aspects across
the boundary. Ports do. When a critical aspect must hold on both sides of
a call, model it with a port.

## Relation types

Six types split into two families:

**Structural** — how code is composed:
- \`calls\` — node A invokes a function/method of B
- \`uses\` — node A depends on B's data/state
- \`extends\` — node A extends B (e.g. class inheritance)
- \`implements\` — node A implements B's interface/contract

**Event-based** — async / decoupled:
- \`emits\` — A emits events
- \`listens\` — A listens for events

Event relations must be paired: if A emits to B, B must declare a
\`listens\` from A. \`yg check\` enforces this.

## Architecture controls allowed relations

\`yg-architecture.yaml\`'s allowed-relations configuration per type controls
which relation types may target which node types. The validator rejects
relations not permitted by the architecture.

When a needed relation is not allowed by the architecture:
1. Use a different relation type that IS allowed
2. Change one node's type
3. Update the architecture to permit the relation (requires user
   confirmation — never silent)

## Ports — named entry points with aspects

A port on a node says: "consumers of this endpoint must satisfy these
aspects." In \`yg-node.yaml\`:

\`\`\`yaml
name: PaymentsService
type: service
ports:                                  # map keyed by port name (NOT a list)
  charge:
    description: Capture a payment from the user
    aspects: [correlation-tracking, idempotency-key]
\`\`\`

A consumer references the port via the relation's \`consumes\`. In
\`yg-node.yaml\`, \`relations:\` is a flat list and each entry carries its own
\`type:\`:

\`\`\`yaml
name: OrdersHandler
type: command
relations:                             # flat list; type is a field on each entry
  - target: payments/service
    type: calls
    consumes: [charge]
\`\`\`

(The map-keyed-by-relation-type shape — \`relations: { calls: [...] }\` — is the
\`yg-architecture.yaml\` allowed-relations shape, not the node shape.)

The consumed port's aspects become effective on the consumer through
channel 6. The consumer must now satisfy \`correlation-tracking\` and
\`idempotency-key\` for its own source files, in addition to its other
aspects.

## Why ports exist — defending against cross-file evasion

A critical aspect attached to a parent node propagates to all children via
channel 2 (ancestor). But it does NOT cross relation boundaries: a helper
node living outside the audit-logging parent but invoked from inside it
escapes the audit-logging aspect.

Ports restore the boundary:

1. Define a port on the owner node carrying the critical aspect.
2. The helper node declares \`consumes: [<port-name>]\` on its inbound
   relation.
3. The helper inherits the port's aspects (channel 6 propagation).

An attacker who routes calls through an intermediary without declaring
\`consumes\` will not inherit the port's aspects — but \`yg check\` flags the
missing port contract, surfacing the gap.

## Missing port contracts

If a target node declares ports and the consumer's relation does NOT
declare \`consumes\`, \`yg check\` warns:

\`\`\`
Missing port contract: <consumer> → <target> has ports [<list>],
consumer must declare consumes: [<port-name>] or accept the aspect gap.
\`\`\`

Resolve by declaring which port(s) you consume, OR by accepting the gap
explicitly (with user approval — it is a graph hole that the reviewer
will not catch).

## When to use ports

Use ports when:
- The target node enforces an aspect that consumers MUST also satisfy.
- The aspect must cross node boundaries (helper invoked from owner).
- A security or compliance aspect must extend across files via the call
  chain.

Don't use ports for ordinary internal calls — bare relations are
sufficient when the called-into node has no aspect that the caller must
propagate.

## yg context surfaces port-derived aspects

\`yg context --node <path>\` shows effective aspects per channel. Channel 6
entries are labeled with the source port and target node, making port
contracts visible at the consumer side.

## Aspect status in port aspects

Port aspects (channel 6) may declare \`status:\` to control enforcement level.
A consumer inheriting a draft port aspect is not subject to reviewer enforcement
for that aspect. Advisory and enforced port aspects propagate enforcement
level along with the aspect via the channel 6 path. See:
\`yg knowledge read aspect-status\`.
`;
