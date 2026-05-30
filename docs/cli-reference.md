---
title: CLI Reference
---

You do not need to run these commands in day-to-day use.
Your AI agent runs them automatically.

This page is for inspecting or debugging your graph and enforcement state.

---

## Core workflow (5)

| Command | Purpose |
|---------|---------|
| `yg context --file <path>` / `--node <path>` | Assemble context package |
| `yg impact --file <path>` / `--node <path>` / `--aspect <id>` / `--flow <name>` / `--type <id>` | Blast radius analysis |
| `yg check` | Unified gate — everything wrong, always global |
| `yg approve --node <path>` (repeatable) / `--aspect <id>` / `--flow <name>` | Record baseline after review |
| `yg log add` / `read` / `merge-resolve` | Per-node append-only business log |

### `yg context`

Shows the exact context package your agent reads before working on a node. Output is
structured text with `read:` pointers to content files. Agents read files individually
using their file-reading tool.

```bash
yg context --node <node-path>
yg context --file <file-path>
```

- `--file <path>` — Resolves the owning node automatically, then assembles context. Prints
  owner mapping to stderr. If the file has no graph coverage but other files in the same
  directory are mapped, lists candidate nodes with file counts and a hint to use `--node`.
  Exits 1 if no coverage. Mutually exclusive with `--node`.

### `yg impact`

Shows the blast radius of changes to a node, aspect, flow, or type.
`--file` resolves the owning node automatically, then proceeds as `--node`.

```bash
yg impact --node <path>
yg impact --file <path>
yg impact --aspect <id>
yg impact --flow <name>
yg impact --type <id>
```

- `--node` — Show reverse dependencies, descendants, structural dependents of descendants, flows, aspects, and co-aspect nodes
- `--file` — Resolve owner, then proceed as `--node`
- `--aspect` — Show all nodes where this aspect is effective (own, hierarchy, flow, or implied), plus structural dependents of affected nodes
- `--flow` — Show all participants and their descendants, plus structural dependents of participants
- `--type <id>` — Show all nodes of that architecture type and their source files. Useful
  before adding a default aspect to a type — see how many nodes would be affected.

Exactly one of `--node`, `--file`, `--aspect`, `--flow`, or `--type` is required.

### `yg check`

Unified gate combining structural integrity, drift detection, coverage, and completeness.

```bash
yg check
```

Outputs: header (project, counts, coverage), errors grouped by category
(drift, cascade, structural, architecture, coverage, completeness), warnings,
result (PASS/FAIL with category counts), and suggested next command.

Exit code 0 if fully clean, 1 if any errors found.

#### Aspect-status issue codes

The validator emits the following codes related to aspect status (see
[Aspect Status](/aspect-status) for semantics):

| Code | Severity | Meaning |
|------|----------|---------|
| `aspect-status-invalid` | error | Declared `status:` is not one of `draft`, `advisory`, `enforced` |
| `aspect-status-downgrade` | error | An attach site declares a status lower than the cascade would yield (bump up OK, downgrade is an error) |
| `implies-status-inherit-invalid` | error | `status_inherit:` is not `strictest` or `own-default` |
| `aspect-newly-active` | error | Aspect transitioned from `draft` to `advisory`/`enforced`; baseline missing |
| `aspect-violation-enforced` | error | Enforced aspect reviewer refused — blocks `yg check` |
| `aspect-violation-advisory` | warning | Advisory aspect reviewer refused — surfaces as warning, does not block |

### `yg approve`

Records the current file state as the new baseline after review.

```bash
yg approve --node <path>
yg approve --node <path1> --node <path2> --node <path3>
yg approve --aspect <id>
yg approve --flow <name>
yg approve --dry-run --node <path>
```

Exactly one of `--node`, `--aspect`, or `--flow` is required.

- `--node <path>` (repeatable) — One or more node paths to approve, passing `--node` once per
  path. When a single node has no mapping, CLI redirects to batch-approve its children with
  cascade drift.
- `--aspect <id>` — Batch approve all nodes with cascade drift from this aspect.
- `--flow <name>` — Batch approve all nodes with cascade drift from this flow.
- `--dry-run` — Show what would be sent to the reviewer (aspects, source files, prompt)
  without making the LLM call. Only works with `--node`.

Aspects with effective status `draft` on a node are skipped before reviewer dispatch.
`yg approve` prints a `[draft] node 'X': aspect 'Y' skipped (status: draft)` line for each
and proceeds with the remaining aspects. No baseline verdict is recorded for draft aspects.
See [Aspect Status](/aspect-status).

### `yg log`

Per-node append-only log of business decisions, constraints, and reasoning. Agents write
to this log before approving changes so that future agents have context about why code
is written the way it is.

```bash
yg log add --node <path> --reason "<text>"
yg log add --node <path> --reason-file <file>
yg log read --node <path> [--top N]
yg log read --node <path> --all
yg log merge-resolve --node <path>
```

- `add` — Append an entry. `--reason "<text>"` for inline text; `--reason-file <path>` for
  multi-line content from a file. The entry gets a timestamp header automatically.
  Requires `--node`. When `log_required: true` is set on the node's type (the default),
  `yg approve` enforces that at least one log entry exists before running the reviewer.
- `read` — Print entries newest-first. Default: top 10. `--top N` shows N entries.
  `--all` shows the full history. `--top` and `--all` are mutually exclusive. Use this
  before editing a node to understand past decisions.
- `merge-resolve` — Reconcile `log.md` after a git merge. Must be run from a merge commit.
  Validates byte-exact ancestor portion and unions new entries from both branches.
  Never manually concatenate log files — integrity hashes will break.

---

## Navigation (6)

| Command | Purpose |
|---------|---------|
| `yg tree [--root <path>] [--depth <n>]` | Graph structure |
| `yg find "<query>"` | Natural-language graph search |
| `yg aspects` | List aspects |
| `yg flows` | List flows |
| `yg owner --file <path>` | Quick ownership lookup |
| `yg type-suggest --file <path>` | Suggest architecture type for a file |

### `yg tree`

Prints all nodes with path, type, and description in a hierarchical tree.

```bash
yg tree [--root <path>] [--depth <n>]
```

- `--root <path>` — Show only subtree rooted at this path
- `--depth <n>` — Maximum depth

### `yg find`

Natural-language search across nodes and aspects (flows are not indexed). Returns results
ranked by relevance. Each result shows the `score`, the `Kind` (node/aspect), and a short
`Description`. Node results also print a `Type:` line; aspect results print a `status:` line.
A `Matched:` line lists the query terms that matched.

```bash
yg find "order cancellation"
yg find "authentication middleware"
```

Use this when you know the feature you want to work on but not the node path.
Scores above 0.6 are usually reliable; below 0.3, verify with `yg context`.

### `yg aspects`

Lists all defined aspects with metadata.

```bash
yg aspects
```

Output: a custom human-readable line format (not YAML). Each aspect renders as a header line
`<id> [<status>] — <description>` (the description falls back to the aspect name when no
description is set — there is no separate `name` field), followed by a `Reviewer:` line (for
`llm` reviewers it also shows the tier), a usage line `Used by: N nodes
(architecture/direct/implied/flow)` — or `Used by: 0 nodes — orphaned` when nothing references
it — and an `Implies:` line when the aspect implies others.

### `yg flows`

Lists all defined flows with metadata.

```bash
yg flows
```

Output: a custom human-readable line format (not YAML) with fields: `name`, `nodes`
(participants), `aspects`.

### `yg owner`

Finds which node owns a given file. Path is relative to repository root.
Quick ownership check — use `yg context --file` when you need the full context package.

```bash
yg owner --file <path>
```

### `yg type-suggest`

Suggests which architecture type(s) a file belongs to, based on `when` predicates
in `yg-architecture.yaml`. Useful when creating a new file and you're not sure which
node type to assign.

```bash
yg type-suggest --file src/orders/refund.service.ts
```

If the file does not exist yet, runs path-predicate checks only and shows which types
match the path pattern. If the file exists, runs the full `when` predicate (path +
content). If multiple types match, the architecture has overlapping `when` rules that
need disambiguating. If no type matches, shows the closest types by satisfied-fraction
to help you choose where to move or refactor the file.

---

## Knowledge base (1)

| Command                              | Purpose                        |
|--------------------------------------|--------------------------------|
| `yg knowledge list` / `read <name>` | Built-in deep-dive documentation |

### `yg knowledge`

Accesses built-in documentation on Yggdrasil mechanisms. The agent uses this
to answer detailed questions about how things work without reading source code.

```bash
yg knowledge list
yg knowledge read <name>
```

Available topics include: `working-with-architecture`, `aspects-overview`, `aspect-status`,
`writing-llm-aspects`, `writing-ast-aspects`, `writing-structure-aspects`,
`conditional-aspects`, `suppress-syntax`, `drift-and-cascade`, `configuration`,
`cli-reference`, `log-management`, `ports-and-relations`, `flows`.

Run `yg knowledge list` to see the current list with one-line descriptions.

---

## Development (1)

| Command                                                          | Purpose                               |
|------------------------------------------------------------------|---------------------------------------|
| `yg ast-test --aspect <id> --node <path>` / `--files <paths...>` | Run AST aspect check without approving |
| `yg structure-test --aspect <id> --node <path>` | Run structure aspect check without approving |

### `yg ast-test`

Runs an AST aspect's `check.mjs` against source files and prints violations. Use this
during authoring to iterate on the check logic without going through the full approve cycle.

```bash
yg ast-test --aspect <id> --node <node-path>
yg ast-test --aspect <id> --files <path> [<path2> ...]
```

- `--aspect <id>` — Required. The aspect must have `reviewer.type: ast` in its `yg-aspect.yaml`.
  Exits 1 with an error if the aspect uses the LLM reviewer.
- `--node <path>` — Run against all files mapped to this node.
- `--files <paths...>` — Run against an explicit file list. Useful for ad-hoc testing
  before wiring the aspect into the graph.

Exits 0 with "No violations" if all checks pass. Exits 1 if any violations found,
with file path, line number, and violation message for each.

### `yg structure-test`

Runs a structure aspect's `check.mjs` against a named node and prints violations —
the structure-reviewer counterpart of `yg ast-test`. Use it to iterate on a
structure `check.mjs` without the full approve cycle.

```bash
yg structure-test --aspect <id> --node <node-path>
yg structure-test --aspect <id> --node <node-path> --check-determinism
```

- `--aspect <id>` — Required. The aspect must have `reviewer.type: structure`.
- `--node <path>` — Required. Runs the check with the node's sandboxed `ctx`
  (its own files plus, via declared relations, related nodes' files and metadata).
- `--check-determinism` — Runs the check twice and exits 1 if the violation sets
  differ (lexically sorted), catching side effects in `check.mjs`.

Exits 0 with no violations, 1 otherwise.

---

## Setup (1)

| Command | Purpose |
|---------|---------|
| `yg init` | Initialize or reconfigure |

```bash
yg init
yg init --upgrade --platform claude-code
```

Interactive wizard. On a new project: walks you through platform selection and
reviewer setup. On an existing project: offers upgrade, reviewer reconfiguration,
or platform change.

Non-interactive mode: `--upgrade --platform <name>` refreshes rules and schemas
without prompts. Useful in scripts and CI.
