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
yg approve --aspect audit-logging                     # all nodes with aspect
yg approve --flow order-processing                    # all nodes in flow
yg approve --dry-run --node orders/handler            # preview, no LLM call
\`\`\`

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

List all aspects with usage counts and reviewer type.

\`\`\`bash
yg aspects
\`\`\`

## yg flows

List all flows with participants and aspects.

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

## yg find

Locate entry-point nodes/aspects by natural-language query.

\`\`\`bash
yg find "order cancellation"
yg find "authentication middleware"
\`\`\`

Returns ranked candidates with score. Score >0.6: likely correct entry
point. Score <0.3: weak match, verify.

## yg log

Append and read per-node business-context log entries.

\`\`\`bash
yg log add --node orders/handler --reason "Added cancellation at billing cycle end"
yg log read --node orders/handler              # top 10 entries, newest first
yg log read --node orders/handler --top 5
yg log read --node orders/handler --all
yg log merge-resolve --node orders/handler     # after git merge with conflicting logs
\`\`\`

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
`;
