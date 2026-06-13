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
| `yg check` | Unified gate — pure read, hash-only, no LLM, no keys |
| `yg check --approve` | Verify every unverified pair and record the verdicts in the lock |
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

The node view also reports, per effective aspect, how many files form its subject
set (including `0 files — vacuous` when a `scope.files` filter excludes everything),
and a log-state line — whether a fresh log entry is required before `yg check
--approve` and whether one is present.

### `yg impact`

Predicts which pairs an edit to a node, aspect, flow, or type would invalidate —
the cost surface before you make the change. Counts are reviewer calls
× consensus for LLM pairs; deterministic pairs are free. `--file` resolves the
owning node automatically, then proceeds as `--node`.

```bash
yg impact --node <path>
yg impact --file <path>
yg impact --aspect <id>
yg impact --flow <name>
yg impact --type <id>
```

- `--node` — Reverse dependencies, descendants, structural dependents of descendants, flows, aspects, and co-aspect nodes
- `--file` — Resolve owner, then proceed as `--node`. Also reflects deterministic checks whose recorded observations touched this file (cross-node impact).
- `--aspect` — All nodes where this aspect is effective (own, hierarchy, flow, or implied), plus structural dependents of affected nodes — the pairs an edit to its rule, description, references, scope, or tier would re-verify
- `--flow` — All participants and their descendants, plus structural dependents of participants
- `--type <id>` — All nodes of that architecture type and their source files. Useful
  before adding a default aspect to a type — see how many nodes would be affected.

Exactly one of `--node`, `--file`, `--aspect`, `--flow`, or `--type` is required.

### `yg check`

Unified gate combining structural integrity, the prompt-size gate, lock
verification, coverage, and completeness. It is a **pure read** — it recomputes
each expected pair's input hash and compares it to the recorded verdict in
`.yggdrasil/yg-lock.json`. It makes no LLM calls, executes no deterministic
checks, and needs no provider config or keys.

```bash
yg check
yg check --approve
```

Outputs: header (project, counts, coverage), errors grouped by category
(verification, structural, architecture, coverage, completeness), warnings,
result (PASS/FAIL with category counts), and suggested next command.

Exit code 0 if fully clean, 1 if any errors found.

#### `--approve` — fill unverified pairs

`yg check --approve` runs every unverified pair, repo-wide (there is no scoping —
verification is all-or-nothing), then reports. Deterministic pairs run first,
locally, for free; a node with an enforced deterministic refusal has its LLM
pairs skipped this run. LLM pairs then go to the reviewer per tier and consensus.
Each real verdict — approved or refused — is recorded in the lock; infrastructure
failures (provider unreachable, no reviewer configured, a `check.mjs` that throws)
write nothing and leave the pair unverified. A refusal is cached and final for
unchanged inputs: re-running does not re-roll it.

`yg check --approve` prints a pre-dispatch header naming how many pairs and nodes
it will fill and how many are deterministic (free) vs. reviewer calls. There is no
preview or confirmation mode — use `yg impact` to predict cost before an edit, and
`yg aspect-test --dry-run` to preview a single LLM prompt.

#### Verification and aspect-status issue codes

The validator emits the following codes (see [Aspect Status](/aspect-status) for
status semantics):

| Code | Severity | Meaning |
|------|----------|---------|
| `unverified` | error (enforced) / warning (advisory) | Expected pair has no valid verdict — new, edited, tampered, or a fill that failed on infrastructure. Next: `yg check --approve`. |
| `aspect-violation-enforced` | error | Valid `refused` verdict on an enforced pair — blocks `yg check`. |
| `aspect-violation-advisory` | warning | Valid `refused` verdict on an advisory pair — does not block. |
| `prompt-too-large` | error | Assembled LLM prompt exceeds the resolved tier's `max_prompt_chars`. Takes precedence over `unverified`; `--approve` skips the pair. |
| `lock-invalid` | error | `yg-lock.json` is unparseable, garbled, conflict-markered, or an unknown version — fail closed. |
| `aspect-check-runtime-error` | error (`--approve` only) | A `check.mjs` failed to import or threw at fill time — fail closed, no verdict written. |
| `log-entry-missing` | error (`--approve` only) | A `log_required` node changed source without a fresh log entry. |
| `aspect-status-invalid` | error | Declared `status:` is not one of `draft`, `advisory`, `enforced`. |
| `aspect-status-downgrade` | error | An attach site declares a status lower than the cascade would yield (bump up OK, downgrade is an error). |
| `implies-status-inherit-invalid` | error | `status_inherit:` is not `strictest` or `own-default`. |

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
  Requires `--node`. When a node's type opts in with `log_required: true`, `yg check
  --approve` requires a fresh log entry before it records a verdict for a source change
  on that node.
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
| `yg suppressions` | Inventory of active `yg-suppress` markers |
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
A `Matched:` line lists the query terms that matched (deduplicated and capped to the
first few, with a `(+N more)` suffix when the full set is longer).

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
`writing-llm-aspects`, `writing-deterministic-aspects`,
`conditional-aspects`, `suppress-syntax`, `verification-and-lock`, `configuration`,
`cli-reference`, `log-management`, `ports-and-relations`, `flows`.

Run `yg knowledge list` to see the current list with one-line descriptions.

---

## Development (1)

| Command                                                          | Purpose                               |
|------------------------------------------------------------------|---------------------------------------|
| `yg aspect-test --aspect <id> --node <path>` / `--files <paths...>` | Run an aspect of either kind on demand; never writes the lock |

### `yg aspect-test`

Runs a single aspect — deterministic or LLM — against a node or an explicit file
list, and prints the result. It is a **diagnostic**: it always runs live and never
writes the lock, so use it freely while authoring a rule. Every run that produces a
result ends with `diagnostic only — lock unchanged; yg check still reports the
stored verdict`.

```bash
yg aspect-test --aspect <id> --node <node-path>
yg aspect-test --aspect <id> --files <path> [<path2> ...]
yg aspect-test --aspect <id> --node <node-path> --check-determinism
yg aspect-test --aspect <id> --node <node-path> --dry-run
```

- `--aspect <id>` — Required. The aspect's kind is inferred from its rule source.
- `--node <path>` — Run against the files mapped to this node, with the node's allow-listed
  `ctx` (its own files plus, via declared relations, related nodes' files and metadata). The
  allow-list is a read *discipline* that scopes which files count as observations — not a
  security sandbox; `check.mjs` runs with full Node privileges.
- `--files <paths...>` — Run against an explicit file list (deterministic aspects). Useful
  for ad-hoc testing before wiring the aspect into the graph.
- `--check-determinism` — (deterministic) Runs the check twice and exits 1 if the violation
  sets differ (lexically sorted), catching side effects and machine-dependence in `check.mjs`.
- `--dry-run` — (LLM) Prints the assembled reviewer prompt(s) for the aspect's scope and makes
  no LLM calls. The sanctioned way to inspect a prompt before switching an aspect to `per: file`.

For a deterministic aspect it runs `check.mjs` and prints violations. For an LLM
aspect it runs the reviewer (or just prints the prompt under `--dry-run`). Exits 0
when clean, 1 when violations or refusals are found.

When `yg aspect-test` repeatedly approves what the lock has refused, the rule text
is ambiguous — sharpen `content.md` (which re-verifies every pair of the aspect; check
`yg impact --aspect` first) or propose a suppress. There is deliberately no command
to drop or re-roll a recorded verdict.

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

`yg init` also maintains a `.gitattributes` entry marking `yg-lock.json` as
generated (`linguist-generated=true`) and writes `max_prompt_chars: 50000` into the
generated reviewer tier.

Non-interactive mode: `--upgrade --platform <name>` lifts the config version to the
current one and refreshes rules, schemas, and platform files — without prompts.
Useful in scripts and CI.
