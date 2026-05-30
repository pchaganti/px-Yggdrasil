# Aspect Status

Yggdrasil aspects ship with three enforcement levels: `draft`, `advisory`,
`enforced`. Status controls whether the reviewer runs and how `yg check`
renders violations. It is the dial you turn as a rule matures — start
silent, gather signal, then enforce.

## Three levels

| Status      | Reviewer runs? | Refused renders as | Blocks `yg check`? |
|-------------|----------------|--------------------|--------------------|
| `draft`     | no             | n/a (skipped)      | no                 |
| `advisory`  | yes            | warning            | no                 |
| `enforced`  | yes            | error              | yes                |

`draft` aspects are dormant — `yg approve` prints a skip line and never
calls the reviewer. `advisory` aspects pay the full reviewer cost but
their refusals surface as warnings only. `enforced` is the default and
matches pre-5.0 behavior: refusals block CI.

## When to use each

- **`draft`** — content.md / check.mjs is still being authored, or the
  rule is unclear. Zero cost, zero enforcement. Use this while iterating
  on the rule text before any node has a real verdict.
- **`advisory`** — rule is complete; gather signal across the repo
  without blocking CI. Full reviewer cost, warnings only. Use this to
  measure how often a rule fires on real code before promoting it.
- **`enforced`** — rule is vetted; violations should block CI. Full
  reviewer cost, errors that block `yg check`.

A typical lifecycle: draft while authoring → advisory for one or two
sprints to observe behavior → enforced once you have confidence the rule
fires only on real violations.

## Declaring status

`status:` can appear on the aspect itself (aspect-level default) and on
every object-form attach site. The aspect-level default applies wherever
the aspect attaches unless an attach site declares its own.

### Aspect-level default

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
name: Audit Logging
description: "Every mutation emits an audit event"
status: advisory               # default for every attach site
reviewer:
  type: llm
```

If `status:` is omitted, the aspect defaults to `enforced` — same
behavior as 4.x.

### Per-node attach site

```yaml
# .yggdrasil/model/orders/yg-node.yaml
aspects:
  - id: audit-logging
    status: enforced           # promote on this node only
```

Bare-string entries (`- audit-logging`) inherit the aspect-level default.
Object form (`{ id, status }`) is the only way to override per site.

### Architecture node-type default

```yaml
# .yggdrasil/yg-architecture.yaml
node_types:
  command:
    aspects:
      - id: cli-contract
        status: enforced
```

### Flow-level

```yaml
# .yggdrasil/flows/checkout/yg-flow.yaml
aspects:
  - id: correlation-tracking
    status: advisory
```

### Port-level

```yaml
# .yggdrasil/model/payments/yg-node.yaml
ports:
  charge:
    aspects:
      - id: idempotency
        status: enforced
```

## How effective status is computed

For each (node, aspect) pair, the resolver collects every channel that
attaches the aspect (after `when` filtering), then takes the maximum:

```
effective_status = max(declared in each channel)
```

where `draft < advisory < enforced`. The strictest level wins.

If an attach site explicitly declares a status **lower** than what the
cascade would yield from other channels (plus the aspect-level default),
the validator emits `aspect-status-downgrade` as an error. The rule is
**bump up OK, downgrade is an error**: a node can promote an aspect to
`enforced`, but it cannot quietly weaken what the architecture or a flow
demands.

To resolve a downgrade error: remove the explicit lower status from the
attach site, or raise the lower-ranked channel to match.

This `max()` computation and the downgrade check apply to the cascading
attach channels 1–6 (own, ancestor, own type, ancestor type, flows,
ports). Channel 7 (implies) does not declare a `status:` — it carries
`status_inherit:` instead, described in the next section.

## Implies propagation

For aspect `A` that implies aspect `B`, propagation to a node depends on
A's effective status on that node and the `status_inherit:` modifier on
the implies edge.

### Draft is dormant

If A's effective status on node N is `draft`, then B is **not** propagated
via implies. Draft aspects have zero side effects. B may still arrive on
N through any other channel.

### Active implier — `status_inherit` modes

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
implies:
  - id: diagnostic-logging
    status_inherit: strictest        # default
```

Two modes:

- **`strictest`** (default) — B contributes `max(A_effective, B_default)`
  to the cascade. An implies bundle promotes its companions. If A runs as
  `enforced` and B defaults to `advisory`, B becomes `enforced` on that
  node.
- **`own-default`** — B contributes `B_default` regardless of A. Use this
  to decouple propagation when an implied aspect should retain its own
  status even when reached through a stricter implier.

```yaml
implies:
  - id: diagnostic-logging
    status_inherit: own-default      # keep B at its own default
```

Bare-string implies entries (`implies: [diagnostic-logging]`) inherit the
`strictest` default.

## Migrating from 4.x

5.0.0 introduces status. Existing aspects without a `status:` field
default to `enforced` — the same behavior as 4.x. Run `yg init --upgrade`
to migrate; the migrator inspects your graph and warns about two patterns
that may behave differently under the new defaults:

1. **Escalation via `strictest`** — `implies: [B]` where A is enforced
   and B's default is `advisory` or `draft`. Under the new `strictest`
   default, B will run as enforced wherever it reaches a node through A.
   The warning lists the implier, implied, both defaults, and the number
   of affected nodes. To keep the old behavior, add
   `status_inherit: own-default` on the implies entry.

2. **Downgrade** — any attach site with explicit `status:` lower than
   the cascade anchor. The warning gives the file path and the conflicting
   values. Fix by removing the explicit status, or raise the cascade
   channel to match.

If the migrator finds either pattern, it withholds the version bump.
Resolve the warnings and re-run `yg init --upgrade`.

## Status and drift

Status is **not** part of the canonical drift hash. The hash stays stable
across `advisory ↔ enforced` flips — these transitions do not cascade
re-approvals.

Transitions that affect drift:

- **`draft → advisory/enforced`** — produces drift indirectly: the node
  now has no baseline verdict for the newly active aspect. Surfaced as
  `aspect-newly-active` in `yg check`.
- **`advisory → enforced`** — does **not** drift. However, if the
  baseline already contains a refused verdict, CI flips from green to
  red overnight. Promote intentionally and expect the existing baseline
  to surface.
- **`active → draft`** — does **not** drift. The stale baseline entry
  is cleared lazily on the next `yg approve` of the node.

## `when` is not `status`

The `when` predicate decides whether an aspect **applies** to a node.
Status decides what happens **when it applies**. They are orthogonal:

- `when=false` → aspect is invisible on the node. No reviewer, no
  verdict, no display in `yg context`. Costs nothing.
- `status=draft` → aspect applies but is dormant. Appears in `yg
  context`, no reviewer call, no verdict in baseline.

Use `when` to model applicability (this rule only applies to nodes that
call an external service). Use `status` to model rule maturity (this
rule is still being authored / observed / enforced).

See [Conditional Aspects](/conditional-aspects) for the `when` predicate
grammar.

## See also

- [Core Concepts](/core-concepts) — aspects, the seven channels, drift
- [Reviewers](/reviewers) — how the reviewer is invoked
- [Conditional Aspects](/conditional-aspects) — `when` predicates
- [CLI Reference](/cli-reference) — issue codes emitted by `yg check`
