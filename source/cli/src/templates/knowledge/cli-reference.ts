export const summary =
  'Full yg command reference: check, check --approve, context, aspect-test, impact, tree, aspects, flows, find, log, owner, type-suggest, init, knowledge, schemas';

export const content = `# CLI reference

All commands assume you are in the repository root with a \`.yggdrasil/\`
directory. Run \`yg init\` to bootstrap if missing.

## yg check

Unified gate — writes nothing. Validates the lock, structure, and coverage; runs
no aspect reviewers and makes no LLM calls. It does recompute the built-in
relation-conformance check live (parse + resolve), at zero LLM cost.

\`\`\`bash
yg check
\`\`\`

Reports: unverified pairs (no valid verdict — new, edited, tampered, or
fill-failed), cached refusals (rendered from the lock), validation errors,
coverage gaps (\`unmapped-files\` errors under required roots,
\`uncovered-advisory\` warnings outside them), type-when mismatches, strict
orphans/misplaced files, \`prompt-too-large\`, \`lock-invalid\`. Severity of a pair
follows its effective status: enforced → error (blocks), advisory → warning.

Exit 0 = clean. Exit 1 = errors found. CI runs it cheap and keyless.

## yg check --approve

Fill every unverified pair, then report. The only writer of verdicts (alongside
\`yg log merge-resolve\`, which writes the per-node log baseline).

\`\`\`bash
yg check --approve
\`\`\`

Verification is repo-wide and all-or-nothing — there are no scoping flags. The
order: a pre-dispatch header (\`Filling N unverified pairs across M nodes — D
deterministic (no cost), K reviewer calls (consensus included)\`); the per-node
log gate; deterministic
fills first (free); the deterministic gate (a node with an enforced deterministic
refusal has its LLM fills skipped this run); then LLM fills. A real verdict
(approved or refused) is written to the lock; every infra disposition writes
nothing and the pair stays unverified. Refusals are cached and FINAL for unchanged
inputs. Interrupting is safe — finished pairs persist, the next run resumes.

When nothing was unverified, the summary says \`0 reviewer calls made — all
expected pairs hold valid verdicts\`. Use \`yg impact\` to predict cost before
editing.

## yg context

Show the graph context for a file or node.

\`\`\`bash
yg context --file src/orders/handler.ts
yg context --node orders/handler
\`\`\`

File form shows: owning node, effective aspects with \`read:\` paths,
dependencies. Node form shows: aspects (with per-aspect subject-file counts,
including \`0 files — vacuous\`), flows, dependents, source files, and the log
state line (\`log entry required before --approve: yes/no; fresh entry present:
yes/no\`).

Read the files listed under \`read:\` before editing any source file — they
contain the rules the reviewer will check your code against.

## yg aspect-test

Diagnostic — run a check or reviewer LIVE without writing the lock. Works for
both reviewer kinds.

\`\`\`bash
# Deterministic: run check.mjs against a node or ad-hoc files
yg aspect-test --aspect sibling-test-file --node orders/handler
yg aspect-test --aspect no-sync-fs --files src/orders/handler.ts
yg aspect-test --aspect sibling-test-file --node orders/handler --check-determinism

# LLM: run the reviewer, or preview the assembled prompt
yg aspect-test --aspect test-quality --node orders/handler
yg aspect-test --aspect test-quality --node orders/handler --dry-run
\`\`\`

Every run that produces a result ends with the footer \`diagnostic only — lock
unchanged; yg check still reports the stored verdict\`. \`--dry-run\` prints the
assembled prompt(s) including resolved companions, runs the companion hook live
(if present), but makes no reviewer or LLM calls and does not write the lock.
\`--check-determinism\` runs a deterministic check twice and fails if the
violation sets differ. If aspect-test repeatedly approves what the lock refuses,
the rule text is ambiguous — sharpen \`content.md\` (cascades; check
\`yg impact\`) or propose a \`yg-suppress\`; there is deliberately no
verdict-drop.

## yg impact

Show blast radius before a change — which pairs an edit would invalidate.

\`\`\`bash
yg impact --node orders/handler        # dependents, flows, affected pairs
yg impact --file src/orders/handler.ts # pairs whose subject set includes this file
yg impact --aspect audit-logging       # all pairs of this aspect
yg impact --flow order-processing      # all pairs of nodes in this flow
yg impact --type service               # all nodes of this type + coverage
\`\`\`

Counts are reviewer calls × consensus for LLM pairs; deterministic pairs are free.

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

## yg find

Locate entry-point nodes/aspects by natural-language query.

\`\`\`bash
yg find "order cancellation"
yg find "authentication middleware"
\`\`\`

Returns ranked candidates. Scores are RELATIVE — the top result is always
\`1.00\` and the rest are its fraction, not an absolute confidence. A large
gap from #1 to #2 (e.g. \`1.00\` then \`0.40\`) signals a confident winner;
closely-clustered scores (\`1.00\`, \`0.95\`, \`0.90\`) mean the query is
ambiguous — verify the top few with \`yg context\`. \`yg find\` indexes nodes
and aspects only — not flows.

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

## yg suppressions

Read-only inventory of all active \`yg-suppress\` markers in the repository's
source files. Lists each marker's aspect path, location, reason, and kind
(single-line, bracket, or wildcard). Exits 0 always — it is a read-only
inspection tool.

\`\`\`bash
yg suppressions
\`\`\`

Emits non-blocking warnings for:
- **Unknown aspect-id** — the aspect path in the marker does not match any known aspect.
- **Wildcard suppress** (\`*\`) — suppresses all aspects in range; any aspect added later is also silently waived.
- **Unbounded range** — a \`yg-suppress-disable\` marker with no matching \`yg-suppress-enable\`; the suppression extends to end of file.

Use \`yg suppressions\` to audit accumulated waivers before a release or a new aspect rollout. It does not affect \`yg check\` or the lock.

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

## yg schemas

Browse the embedded graph-element schema references — the field reference for
each graph element. Graph-independent: works without a \`.yggdrasil/\` present.

\`\`\`bash
yg schemas list                # list the schemas (node, aspect, architecture, config, flow)
yg schemas read <name>         # print one schema's field reference
\`\`\`

## yg init

Bootstrap or refresh \`.yggdrasil/\` setup.

\`\`\`bash
yg init                        # initial setup — writes config (incl. max_prompt_chars) + .gitattributes
yg init --upgrade              # refresh rules/platform files + .gitattributes; lift version bookkeeping
yg init --upgrade --platform claude-code   # regenerate for specific platform
\`\`\`

\`yg init\` maintains \`.gitattributes\` so \`yg-lock.json\` is marked
\`linguist-generated\`. Run from repository root only. Never from a subdirectory.

## Validator issue codes — verification and status

The validator (\`yg check\`) emits the following issue codes:

| Code | Severity | Meaning |
|------|----------|---------|
| \`unverified\` | error (enforced) / warning (advisory) | Expected pair has no valid verdict. Next: \`yg check --approve\`. |
| \`aspect-violation-enforced\` | error | Enforced aspect refused (valid refused lock entry — cached) |
| \`aspect-violation-advisory\` | warning | Advisory aspect refused |
| \`aspect-check-runtime-error\` | error (\`--approve\` report) | \`check.mjs\` failed to import/run at fill time — fail closed; plain check shows the pair as \`unverified\` |
| \`aspect-companion-without-content\` | error | \`companion.mjs\` present without \`content.md\` — companion files require an LLM aspect |
| \`aspect-companion-with-check\` | error | \`companion.mjs\` present alongside \`check.mjs\` — companion files are an LLM add-on only |
| \`aspect-companion-runtime-error\` | error (\`--approve\` report) | \`companion.mjs\` failed to resolve/run at fill time (hook threw, bad return shape, missing path, path outside allowed-reads, or observations stayed inconsistent) — fail closed; plain check shows the pair as \`unverified\` |
| \`prompt-too-large\` | error | Assembled prompt exceeds the resolved tier's \`max_prompt_chars\` |
| \`lock-invalid\` | error | Lock unparseable, garbled, conflict-markered, or unknown version — fail closed |
| \`relation-undeclared-dependency\` | error (always) | Built-in relation-conformance check: node depends on another node's code without a declared, sanctioned relation. Not an aspect — not status-governed, not suppressible. Next: declare the relation in \`yg-node.yaml\` or remove the dependency. |
| \`log-entry-missing\` | error | \`--approve\` log gate fired |
| \`aspect-status-invalid\` | error | Declared status is not one of \`draft\\|advisory\\|enforced\` |
| \`aspect-status-downgrade\` | error | Declared status is lower than cascade would yield (bump up OK, downgrade is error) |
| \`implies-status-inherit-invalid\` | error | \`status_inherit:\` value not one of \`strictest\\|own-default\` |

For detailed semantics of status: \`yg knowledge read aspect-status\`. For the lock,
verification, and caching: \`yg knowledge read verification-and-lock\`.
`;
