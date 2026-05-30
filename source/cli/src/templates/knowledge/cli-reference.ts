export const summary = 'Full yg command reference: check, context, approve, impact, tree, aspects, flows, find, log, knowledge';

export const content = `# CLI reference

All commands assume you are in the repository root with a \`.yggdrasil/\`
directory. Run \`yg init\` to bootstrap if missing.

## yg check

Unified gate — runs all validators in sequence.

\`\`\`bash
yg check
\`\`\`

Detects: drift (source + cascade), validation errors, coverage gaps,
\`unmapped-files\`, type-when mismatches, strict orphans/misplaced files.

Exit 0 = clean. Exit 1 = errors found. CI blocks on exit 1.

## yg context

Show the graph context for a file or node.

\`\`\`bash
yg context --file src/orders/handler.ts
yg context --node orders/handler
\`\`\`

File form shows: owning node, effective aspects with \`read:\` paths,
dependencies. Node form shows: aspects, flows, dependents, source files.

Read the files listed under \`read:\` before editing any source file — they
contain the rules the reviewer will check your code against.

## yg approve

Run the reviewer against node source files.

\`\`\`bash
yg approve --node orders/handler
yg approve --node orders/handler --node orders/repo   # batch
yg approve --aspect audit-logging                     # nodes with cascade drift from this aspect
yg approve --flow order-processing                    # nodes with cascade drift from this flow
yg approve --dry-run --node orders/handler            # preview, no LLM call
\`\`\`

\`--aspect\` and \`--flow\` re-approve only the nodes that have cascade drift
from that aspect or flow — not every node carrying the aspect or in the flow.

Batch at most 3-5 nodes per invocation when using multiple \`--node\` flags.

## yg impact

Show blast radius before a change.

\`\`\`bash
yg impact --node orders/handler        # dependents, flows, cascade scope
yg impact --file src/orders/handler.ts # blast radius for a file
yg impact --aspect audit-logging       # all nodes affected by this aspect
yg impact --flow order-processing      # all nodes in this flow
yg impact --type service               # all nodes of this type + coverage
\`\`\`

## yg tree

Browse the graph structure.

\`\`\`bash
yg tree                        # full tree from root
yg tree --root orders          # subtree from orders/
yg tree --depth 2              # limit depth
\`\`\`

## yg aspects

List all aspects with usage counts and reviewer type. Output is a custom
human-readable line format, not YAML.

\`\`\`bash
yg aspects
\`\`\`

## yg flows

List all flows with participants and aspects. Output is a custom
human-readable line format, not YAML.

\`\`\`bash
yg flows
\`\`\`

## yg owner

Find which node owns a source file.

\`\`\`bash
yg owner --file src/orders/handler.ts
\`\`\`

## yg ast-test

Run an AST aspect check against ad-hoc files (no baseline, no drift).

\`\`\`bash
yg ast-test --aspect no-sync-fs --files src/orders/handler.ts
yg ast-test --aspect no-sync-fs --node orders/handler
\`\`\`

Exits 1 if violations exist. Use during \`check.mjs\` development.

## yg structure-test

Run a structure aspect's \`check.mjs\` against a named node without recording a
baseline — the structure-reviewer counterpart of \`yg ast-test\`.

\`\`\`bash
yg structure-test --aspect sibling-test-file --node orders/handler
yg structure-test --aspect sibling-test-file --node orders/handler --check-determinism
\`\`\`

Exits 1 if violations exist. \`--check-determinism\` runs the check twice and
fails if the violation sets differ, catching side effects in \`check.mjs\`.

## yg find

Locate entry-point nodes/aspects by natural-language query.

\`\`\`bash
yg find "order cancellation"
yg find "authentication middleware"
\`\`\`

Returns ranked candidates with score. Score >0.6: likely correct entry
point. Score <0.3: weak match, verify. \`yg find\` indexes nodes and aspects
only — not flows.

## yg log

Append and read per-node business-context log entries.

\`\`\`bash
yg log add --node orders/handler --reason "Added cancellation at billing cycle end"
yg log add --node orders/handler --reason-file entry.md   # multi-line reason from a file
yg log read --node orders/handler              # top 10 entries, newest first
yg log read --node orders/handler --top 5
yg log read --node orders/handler --all
yg log merge-resolve --node orders/handler     # after git merge with conflicting logs
\`\`\`

Use \`--reason-file <path>\` instead of \`--reason\` to supply multi-line entry
content from a file. On \`yg log read\`, \`--top\` and \`--all\` are mutually
exclusive — you cannot combine them.

## yg type-suggest

Suggest which node_type a file fits based on architecture \`when\` predicates.

\`\`\`bash
yg type-suggest --file src/orders/handler.ts
\`\`\`

## yg knowledge

Browse embedded knowledge topics.

\`\`\`bash
yg knowledge list              # list all topics with summaries
yg knowledge read <name>       # print full topic content
\`\`\`

## yg init

Bootstrap or refresh \`.yggdrasil/\` setup.

\`\`\`bash
yg init                        # initial setup
yg init --upgrade              # migrate config + regenerate platform files
yg init --upgrade --platform claude-code   # regenerate for specific platform
\`\`\`

Run from repository root only. Never from a subdirectory.

## Validator issue codes — aspect status

The validator (\`yg check\`) emits the following issue codes related to aspect
status:

| Code | Severity | Meaning |
|------|----------|---------|
| \`aspect-status-invalid\` | error | Declared status is not one of \`draft|advisory|enforced\` |
| \`aspect-status-downgrade\` | error | Declared status is lower than cascade would yield (bump up OK, downgrade is error) |
| \`implies-status-inherit-invalid\` | error | \`status_inherit:\` value not one of \`strictest|own-default\` |
| \`aspect-newly-active\` | error | Aspect transitioned from draft to advisory/enforced; baseline missing |
| \`aspect-violation-enforced\` | error | Enforced aspect reviewer refused |
| \`aspect-violation-advisory\` | warning | Advisory aspect reviewer refused |

For detailed semantics of status and its mechanics: \`yg knowledge read aspect-status\`.
`;
