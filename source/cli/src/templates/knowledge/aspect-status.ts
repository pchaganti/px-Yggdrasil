export const summary = 'Three-level aspect status (draft / advisory / enforced) — semantics, declaration sites, max() rule, implies propagation, drift mechanics';

export const content = `# Aspect status

Aspect status controls whether the reviewer runs and how \`yg check\` renders
violations. Three levels:

| Status      | Reviewer invoked? | Refused verdict renders as | Blocks \`yg check\`? |
|-------------|-------------------|----------------------------|----------------------|
| \`draft\`   | no                | n/a (skipped)              | no                   |
| \`advisory\`| yes               | warning                    | no                   |
| \`enforced\`| yes               | error                      | yes                  |

Draft aspects are skipped entirely: the reviewer never runs, so a draft aspect
gets no verdict and no baseline. Verdicts for advisory and enforced aspects are
recorded. A code violation of an \`advisory\` aspect does NOT fail \`yg approve\`:
the baseline and per-aspect verdict are still recorded and the CLI exits 0 with
an informational line (the verdict surfaces later as a non-blocking \`yg check\`
warning). Only a code violation of an \`enforced\` aspect refuses (exit 1); a mix
of advisory + enforced refuses on the enforced one. Reviewer infrastructure
failures always block regardless of status.

## Declaration sites

\`\`\`yaml
# yg-aspect.yaml — aspect-level default
status: enforced              # default 'enforced' if absent
implies:
  - id: companion
    status_inherit: strictest # default 'strictest'; alternative 'own-default'

# yg-node.yaml — channel 1 (own) or 2 (cascade to descendants)
aspects:
  - id: rule
    status: enforced

# yg-architecture.yaml — channel 3 (own type) / 4 (ancestor type)
node_types:
  command:
    aspects:
      - id: cli-contract
        status: enforced

# yg-flow.yaml — channel 5
aspects:
  - id: correlation
    status: enforced

# yg-node.yaml ports — channel 6
ports:
  charge:
    aspects:
      - id: tracking
        status: enforced
\`\`\`

## Effective status rule

For each (node, aspect):
1. Collect every channel that attaches the aspect (after \`when\` filtering).
2. Effective status = max() across cascading channels 1–6, where
   draft < advisory < enforced. Channel 7 (implies) does not carry a
   \`status:\` of its own — it propagates via \`status_inherit:\` (see below).
3. If a channel's EXPLICIT declaration on channels 1–6 is lower than the
   cascade would yield without that declaration, the validator emits
   \`aspect-status-downgrade\` — downgrade attempts are validator errors.
   This is the "bump up OK, downgrade is error" rule.

## Implies propagation

For aspect A implies aspect B on node N:
- If A's effective status on N is \`draft\` → B is NOT propagated via implies
  (draft aspects are dormant). B may still arrive via another channel.
- Else:
  - \`status_inherit: strictest\` (default): B contributes max(A_effective, B_default)
  - \`status_inherit: own-default\`: B contributes B_default

## Drift mechanics

- Status is NOT part of the canonical drift hash. The hash stays stable
  across \`advisory ↔ enforced\` flips.
- Transition \`draft → advisory/enforced\` produces drift indirectly via
  missing baseline (emitted as \`aspect-newly-active\`).
- Transition \`advisory → enforced\` does NOT drift but may flip CI from
  green to red overnight if the baseline contains a refused verdict.
- Transition \`advisory or enforced → draft\` does NOT drift; the stale
  baseline entry is cleared lazily on the next \`yg approve\` of the node.

## When to use which status

| Status   | When |
|----------|------|
| draft    | Content.md / check.mjs is still being authored, or the rule is unclear. Zero cost, zero enforcement. |
| advisory | Rule is complete but you want to gather signal across the repo without blocking CI. Full LLM cost, warnings only. |
| enforced | Rule is vetted; violations should block. Full LLM cost, errors that block check. |

## See also

- [[aspects-overview]] — when to create aspects in general
- [[drift-and-cascade]] — full drift mechanics including tier-identity
- [[conditional-aspects]] — \`when\` predicates (orthogonal to status)
- [[writing-llm-aspects]] / [[writing-ast-aspects]] — authoring guide
`;
