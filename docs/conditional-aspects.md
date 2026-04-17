# Conditional Aspects — the `when` filter

Sometimes an aspect attached through a channel applies to only *some* of the
nodes the channel delivers it to. Historically the only way to handle this
was textual — the aspect's `content.md` would say "applies only when X" and
the reviewer (LLM) would read the note and decide N/A per-node. That pays an
LLM call for every N/A node and risks a wrong decision.

The `when` predicate moves that decision into the graph. The CLI evaluates
it deterministically before the reviewer is invoked. If the predicate is
false for a node, the aspect is silently skipped on that node — no LLM
call, no reviewer uncertainty.

## When to reach for `when`

- The aspect is meaningful only when a relation, port, or property holds.
- Splitting the node type to "opt in" would be arbitrary or costly.
- The reviewer is currently deciding N/A via a textual clue in `content.md`.

## Grammar (at a glance)

```yaml
when:
  all_of: [<clause>, ...]    # AND — every clause must pass
  any_of: [<clause>, ...]    # OR — at least one passes
  not: <clause>              # negation
  # Or top-level atomics (implicit all_of):
  relations:
    <relation-type>:
      target_type: <type-id>
      target: <node-path>       # relative to model/
      consumes_port: <port>
  descendants:
    relations: { ... }
    type: <type-id>
    has_port: <port-name>
  node:
    type: <type-id>
    has_port: <port-name>
    has_mapping: true | false
```

Full grammar reference: `graph-schemas/yg-aspect.yaml`.

## Where to declare `when`

- **Globally on the aspect** (`yg-aspect.yaml`, top-level `when:`) — the aspect
  has this precondition *wherever* it is attached.
- **On any attach site** — the same channel-specific list entry can become
  an object with `id` + `when`:

```yaml
aspects:
  - simple-aspect               # no filter
  - id: conditional-aspect      # with filter
    when:
      node: { has_port: charge }
```

Attach sites: `yg-node.yaml` aspects and ports, `yg-architecture.yaml`
`node_types.*.aspects`, `yg-flow.yaml` aspects, and `yg-aspect.yaml` `implies`.

Global and attach-site `when` combine via AND. An aspect is effective on a
node if at least one channel path passes both.

## End-to-end example

Aspect `error-handling/external-api-error-mapping`:

```yaml
name: ExternalApiErrorMapping
description: "Wrap and translate errors from external service clients"
when:
  any_of:
    - relations:
        calls: { target_type: service-client }
    - descendants:
        relations:
          calls: { target_type: service-client }
```

Architecture attaches the aspect on all commands:

```yaml
node_types:
  command:
    aspects: [error-handling/external-api-error-mapping]
```

Result:

- `orders/handler` has `calls: payments/service` where `payments/service`
  is of type `service-client`. Predicate passes → aspect effective →
  reviewer verifies error-mapping in source.
- `follow-ups/crud` has no call to any `service-client`. Predicate fails
  → aspect not effective → reviewer never invoked for it.

Later, a developer adds `calls: payments/service` to `follow-ups/crud`.
`yg check` reports a new effective aspect on the node and prompts
`yg approve --node follow-ups/crud`.

## What `when` is *not*

- **Not for per-file exemptions.** That is what `yg-suppress` is for —
  inline, per-block, reviewer-honored waivers.
- **Not transitive across the relation graph.** A calling B calling C does
  not make C's relations visible on A. The predicate only inspects the
  node's own relations and its hierarchical descendants in `model/`.
- **Not a replacement for splitting an aspect.** If two aspects have
  meaningfully different rules, they should be separate aspects.

## Visibility

`when=false` aspects are silently skipped. They do not appear in
`yg context --node` or `yg context --file`, do not count in
`yg impact --aspect <id>`, and never reach the reviewer. Flipping a
predicate from `false → true` is classified as upstream drift and triggers
a re-approval; flipping from `true → false` is cleanup (no reviewer call).
