# Agent Instructions — Yggdrasil Repository

You work on the Yggdrasil repository: an open-source CLI that provides continuous architecture enforcement for AI-assisted development. This repo both implements Yggdrasil and uses it on itself (dogfooding).

## Context — Where Things Live

| Path                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `source/cli/`           | Implementation — CLI code.                                                          |
| `.yggdrasil/model/cli/` | Graph — describes intended CLI architecture. Aspects enforce rules on source code.  |
| `docs/`                 | User docs — for adopters.                                                           |
| `.plans/`               | Agent working dir — design docs and implementation plans. **Ignore skill paths** (e.g. `docs/plans/`) — always use `<root>/.plans/YYYY-MM-DD-<topic>-design.md` and `.plans/YYYY-MM-DD-<topic>-plan.md`. Gitignored; not committed. |

## Product Scope

`rules.ts` and `agent-rules.md` are consumed by agents in ANY repository that adopts Yggdrasil — not just this one. When editing rules content, examples, or guidance: use domain-neutral examples (no Yggdrasil-specific types or commands). Think "what would help an agent working on an e-commerce app or a mobile game?" not "what would help an agent working on this CLI."

## Constraints

- Never edit generated rules (platform-specific rules files, or the Yggdrasil section in `AGENTS.md`). To change the rules content: edit `source/cli/src/templates/rules.ts` (content) or `source/cli/src/templates/platform.ts` (frontmatter), then build and regenerate: `node source/cli/dist/bin.js init --upgrade --platform claude-code`. **Always regenerate after changing rules.ts** — this repo dogfoods Yggdrasil, so stale rules mean the agent operating on this repo uses outdated instructions.
- **Ignore generated rules files** for understanding: `.yggdrasil/agent-rules.md`, `.cursor/rules/yggdrasil.mdc`, etc. are auto-generated output. Never read or search them. The source of truth for rules content is `source/cli/src/templates/rules.ts`.
- **Always reflect changes in corresponding documentation.** When modifying code behavior, algorithms, or data structures, identify and update all documentation that describes the changed behavior — `docs/` (user docs) and `.yggdrasil/` (graph metadata). Changes to behavior are not complete until every document describing that behavior is consistent.
- **NEVER run `yg init` from a subdirectory.** Always run from the repository root. Running from `source/cli/` or any subdirectory creates a new `.yggdrasil/` there or corrupts the project config. Use `node source/cli/dist/bin.js` for local builds, not `npx yg` (which may use a cached global version).

## Adding Support for a New Agent

To add a new platform (e.g. a new IDE or agent): add it to `source/cli/src/templates/platform.ts` — implement `installFor<Platform>` to write the rules file to the agent's expected location.

## Version Bump & Changelog

- **Changelog is always updated.** Every code or behavior change gets an entry under `## [Unreleased]` in `CHANGELOG.md`. This happens as part of normal work — do not wait for a release.
- **Version bumps only on explicit user request.** Never bump the version in `source/cli/package.json` unless the user explicitly asks for a release. When they do:
  1. Bump version (patch/minor/major per [semver](https://semver.org/)).
  2. Run `npm install` in `source/cli/` to update `package-lock.json`.
  3. Move current version entries to a release section in `CHANGELOG.md`.

## CLI Message Design Principle

Every diagnostic message the CLI outputs to an agent must follow the **what / why / next** structure:

- **WHAT** happened — facts, one line or short block
- **WHY** it's a problem — context the agent needs to understand the situation
- **NEXT** — concrete command or instruction to resolve

Use `buildIssueMessage({ what, why, next })` from `source/cli/src/formatters/message-builder.ts` for all error/warning messages in validator, check, approve, and build-context. The builder enforces the structure; the caller handles presentation (indentation, error code prefix).

This applies to CLI output only. Rules.ts (system prompt) provides the map — workflow, vocabulary, categories. CLI provides the GPS — specific errors, next commands. They share vocabulary but never duplicate information.

## Quality Gate

**ALWAYS run `scripts/repo-check.sh` from repo root before ANY commit and ensure it passes cleanly.** Do not commit with failing checks. This is non-negotiable — every commit must leave the repo in a green state. The script runs typecheck, lint, build, tests with coverage, docs build, markdown lint, and `yg check` in sequence. Do not run these individually before committing — `repo-check.sh` covers everything.

## When Evaluating `yg check` or `scripts/repo-check.sh`

Consider both:

1. **Product** — Is the command correct and useful for adopters?
2. **Dogfood** — Is this repo's graph coverage mature enough? Gaps are expected.

<!-- yggdrasil:start -->
## Yggdrasil

## SYSTEM

Yggdrasil is continuous architecture enforcement. A graph in `.yggdrasil/` describes the architecture. An LLM reviewer verifies source code against it at approve time. If code violates a rule, the reviewer rejects it.

The CLI (`yg`) reads and validates — it never modifies files. You create and edit graph files manually. The CLI guides you: every error message says WHAT happened, WHY it matters, and the NEXT command to run. `suggestedNext` at the end of `yg check` gives one concrete step. Follow it.

### Graph Elements

```
.yggdrasil/
  yg-architecture.yaml ← node type definitions, default aspects per type, allowed relations
  yg-config.yaml       ← reviewer config, quality thresholds, parallelism
  model/               ← nodes: what exists — hierarchy, relations, file mappings
  aspects/             ← aspects: what must be satisfied — enforceable rules
  flows/               ← flows: business processes with node participation
  schemas/             ← YAML schemas — read before creating any graph element
  .drift-state/        ← generated by CLI; never edit manually
```

**Nodes** — components. `model/<path>/yg-node.yaml`. Nodes nest by directory — children inherit parent aspects. Schema: `schemas/yg-node.yaml`.

**Aspects** — enforceable rules. `aspects/<id>/yg-aspect.yaml` + either `content.md` (LLM reviewer) or `check.mjs` (AST reviewer). An aspect can declare `implies: [other-aspect]` — implied aspects are included recursively (must be acyclic). Schema: `schemas/yg-aspect.yaml`.

**Flows** — business processes. `flows/<name>/yg-flow.yaml` with name, description, nodes (participants), aspects. Flow-level aspects propagate to all participants. Descendants of a declared participant are automatically included — adding a parent node to a flow covers all its children.

**Relations** — typed dependencies between nodes. Six types: `calls`, `uses`, `extends`, `implements` (structural) and `emits`, `listens` (event-based). Event relations must be paired — if A emits to B, B must have a listens from A. Architecture controls which relation types are allowed between which node types.

**Ports** — named entry points on a node with required aspects. A node declares ports to say "consumers of this endpoint must satisfy these aspects." Consumers reference ports via `consumes` on their relation. The consumed port's aspects become effective on the consumer (channel 6). If a target has ports, the consumer must declare which it consumes — otherwise check warns about missing port contracts.

**Architecture** — `yg-architecture.yaml` defines the vocabulary: node types, default aspects per type, allowed parent types, allowed relation targets per type. This is the foundation — read it when starting work on a new repo. Changes require user confirmation. Structure details in `schemas/yg-architecture.yaml`.

### How Aspects Reach a Node — 7 Channels + Applicability Filter

Aspects accumulate from multiple sources simultaneously. The reviewer checks ALL of them — the node must satisfy every aspect regardless of origin.

```
EXAMPLE: node "orders/handler" (type: command, child of "orders")

Channel 1: OWN         — node.aspects: [input-validation]
Channel 2: ANCESTOR    — parent "orders" has aspects: [audit-logging]
Channel 3: OWN TYPE    — architecture says type "command" → [cli-command-contract]
Channel 4: ANCESTOR TYPE — parent "orders" type "module" → [] (no defaults here)
Channel 5: FLOWS       — flow "order-processing" includes "orders" → flow aspects: [deterministic]
Channel 6: PORTS       — relation to "payments/service" consumes port "charge" → [correlation-tracking]
Channel 7: IMPLIED     — aspect "audit-logging" implies: [diagnostic-logging]

EFFECTIVE ASPECTS for "orders/handler":
  input-validation      ← own
  audit-logging         ← parent "orders"
  cli-command-contract  ← architecture type "command"
  deterministic         ← flow "order-processing" (via parent "orders")
  correlation-tracking  ← port "charge" on "payments/service"
  diagnostic-logging    ← implied by "audit-logging"
```

Consequences of this cascade:
- Adding an aspect to a parent applies it to ALL children. Check impact first: `yg impact --aspect <id>`.
- Adding a node to a flow with aspects means that node must satisfy flow aspects.
- Architecture default aspects apply to every node of that type automatically.
- Implies chains expand recursively. Cycles are forbidden — CLI detects them.

### Reviewer

The reviewer is an LLM invoked by `yg approve`. It receives: the aspect's content.md + all source files of the node. It checks every rule from content.md against the code.

- **Approved** → baseline recorded, drift cleared.
- **Refused** → violation report with what and where. Fix the code, re-run approve.

Three approve modes: `--node <path>` (one or more nodes), `--aspect <id>` (batch all nodes affected by this aspect change), `--flow <name>` (batch all nodes in this flow). Batch at most 3-5 nodes per invocation — the reviewer loses accuracy with too many. Use `--dry-run` to preview the reviewer prompt without making an LLM call.

### Drift and Cascade

Drift = source code or upstream context changed since the last approve. The reviewer must verify again. `yg check` detects two kinds:

- **Source drift** — mapped source files were modified. Fix: `yg approve --node <path>`.
- **Upstream drift (cascade)** — an aspect, parent node, flow, or dependency changed. This cascades: one aspect change can cause drift in every node that uses it. Fix: `yg approve --aspect <id>` or approve affected nodes individually.

Cascade is the cost multiplier. Before changing a widely-used aspect, run `yg impact --aspect <id>` to see how many nodes will need re-approval. Each is a separate LLM call.

If you modify code without reading the aspect content files (`yg context --file` → follow the `read:` paths), you will likely write code that violates rules you didn't know about. The reviewer will reject it. You will have to read the aspects anyway, then rewrite. Double cost.

Do not interrupt `yg approve` — it processes each aspect across all source files. Interrupting leaves drift state unrecorded. Always read the full raw output — no `| grep`, `| head`, `| tail`. The reviewer already ran; the output is the return on that cost.

### CLI Commands

| Command | Purpose |
|---|---|
| `yg check` | Unified gate — drift, validation, coverage, completeness. Blocks CI. |
| `yg context --file <path>` | Show owning node, effective aspects (`read:` paths), dependencies |
| `yg context --node <path>` | Show node overview — aspects, flows, dependents, source files |
| `yg approve --node <path> [<path2>...]` | Run reviewer on one or more nodes |
| `yg approve --aspect <id>` | Batch approve all nodes affected by this aspect change |
| `yg approve --flow <name>` | Batch approve all nodes in this flow |
| `yg approve --dry-run --node <path>` | Preview reviewer prompt without LLM call |
| `yg impact --node <path>` | Blast radius — dependents, flows, cascade scope |
| `yg impact --file <path>` | Blast radius for a specific file |
| `yg impact --aspect <id>` | All nodes affected by this aspect |
| `yg impact --flow <name>` | All nodes in this flow |
| `yg impact --type <id>` | All nodes of this type, source files, strict coverage gap |
| `yg tree [--root <path>] [--depth <n>]` | Browse graph structure — all nodes with type and description |
| `yg aspects` | List all aspects with usage counts, reviewer type, and sources |
| `yg flows` | List all flows with participants and aspects |
| `yg owner --file <path>` | Find which node owns a source file |
| `yg ast-test --aspect <id> --files <paths...>` | Run AST aspect check against ad-hoc files (no baseline) |
| `yg ast-test --aspect <id> --node <path>` | Run AST aspect check against a node's mapped files |
| `yg type-suggest --file <path>` | Suggest which architecture type best matches a file |
| `yg knowledge list` | List all embedded knowledge topics with summaries |
| `yg knowledge read <name>` | Print the full content of a knowledge topic |
| `yg init` | Bootstrap or refresh `.yggdrasil/` setup |
| `yg find "<query>"` | Locate entry-point nodes/aspects by natural-language query |
| `yg log add --node <path> --reason <text>` | Append a per-node business-context log entry |
| `yg log read --node <path> [--top N \| --all]` | Read log entries (default top 10, newest first) |
| `yg log merge-resolve --node <path>` | Reconcile log.md after a git merge commit |

### Impact and Cost

Every graph change has blast radius. `yg impact` shows how many nodes are affected. Each affected node is a separate reviewer call (LLM request) during approve. An aspect touching 20 nodes = 20 LLM calls = real cost.

When code doesn't match an aspect, three options:

| Option | When | Cost |
|---|---|---|
| **Change code** — conform to aspect | Aspect is correct, code violates it | Proportional to files needing fixes |
| **Change aspect** — conform to code | Aspect is too narrow or wrong, code is correct | `yg impact --aspect` → re-approve ALL nodes with this aspect |
| **Suppress** — `yg-suppress` waiver | Known tech debt, refactor not now | Zero approve cost, consciously accepted risk |

This is a cost/impact trade-off. Assess, propose the option to the user, let them decide. Never choose silently — especially for options 2 and 3.

---

## DECISIONS

### Workflow

**Start of conversation:** `yg check`. If errors — fix before any other work. `yg check` failures block commits and CI. Nothing passes until check is clean.

**Before touching a source file:** `yg context --file <path>`. Read the files listed under `read:` — these are the rules the reviewer will check your code against. For LLM aspects, `read:` points to `content.md`. For AST aspects (`reviewer: ast`), `read:` points to `check.mjs` — read it to know what structural rules will be enforced. For blast radius: `yg impact --file <path>`.

**After modifying code:** `yg check` → fix errors → `yg approve --node <path>`. Approve is part of the change — the change is not done until approve passes. Do not defer approval.

**End of conversation:** `yg check` — resolve all drift. `yg check` failures block CI. If drift remains, the build breaks.

**Unmapped files:** `yg context --file` will say if a file has no owner and suggest candidates. Either add it to an existing node's mapping or create a new node. Code without graph coverage works but is not verified — inform the user and propose options.

**Greenfield (no nodes yet):** Graph before code. Create architecture types, aspects, and nodes first — they are the specification. Then implement code that satisfies the aspects. `yg check` will guide you through coverage gaps.

### Working with architecture

The graph already organizes existing code into nodes with established types
and aspects. When you're EDITING existing files, you don't need to consult
architecture — those files already belong to a node. Use `yg context --file`
to see which node owns a file and what aspects apply.

When you're CREATING something new (new file that doesn't fit any existing
node's mapping, or new functionality that needs a new node), you need a
pre-flight check against architecture FIRST.

When pre-flight applies:
- Creating a new file in a location not covered by any existing node's mapping
- Creating a new node (yg-node.yaml) for new functionality
- Adding a new module/feature area to the codebase

When pre-flight does NOT apply:
- Editing existing source files (their node and aspects are already established)
- Adding source code to an existing node's mapping pattern
- Refactoring within a node's scope

Pre-flight procedure (only for new creation):

1. Read `yg-architecture.yaml` to see what node types exist
2. Pick the type that matches what you're creating (read the type's description)
3. Use the type's allowed parents, allowed relations, default aspects, and
   mapping convention to place the file correctly
4. Create the file in the right location AND the corresponding `yg-node.yaml`
   with the matching type

Skipping pre-flight when it applies leads to aspect violations that block
your commit. Pre-flight read is one file. Retry after rejection is many
cycles.

Example fail-flow (skipping pre-flight when creating new files):

  You create src/api/billing/cancel.ts without checking architecture
    ↓
  yg approve --node billing/cancel
    ↓
  Aspect `ui-no-direct-db` fires: file is under ui/ pattern but imports the DB client
    ↓
  Approve fails: "UI components cannot directly import database clients."
    ↓
  You retry: move file, retry approve, possibly hit another aspect
    ↓
  Multiple iterations versus one pre-flight read.

When no type fits the user's request, do not create files ad-hoc. Push back
to user explaining that architecture lacks a fitting type and consultation
with engineer is needed.

### Working with business-language requests

User requests come in natural language (any language). Yggdrasil artifacts
are in English. Translate keywords before searching the graph.

Translation flow:

1. Read user request — what user-visible behavior do they want?
2. Identify keywords, translate to English
3. Run `yg find "<english keywords>"` to locate entry points
4. Examine the top result's `Kind` line:
   - `Kind: node` → take path from `model/<...>` portion as `--node` argument
     (strip the `model/` prefix). Example: `model/billing/cancel/` → `--node billing/cancel`
   - `Kind: aspect` → do NOT use as `--node`. Read aspect file directly (Read
     tool on path). Look for next `Kind: node` result for entry point.
5. If user request uses cross-cutting words ("all", "every", "across",
   "everywhere"), treat top results as candidate SET, not ranked options.
   Verify each via `yg impact`. Consider whether the change is an aspect
   (cross-cutting concern) rather than per-node edit.
6. Run `yg context --node <path>` for aspects, mapping, relations
7. Read log.md (use `yg log read --node <path> --top 10` for recent context)
8. Make the technical decision
9. Implement

When responding to user:
- Describe changes as user-visible features
  ("Added cancellation that takes effect at end of billing cycle")
- Never use system terms (aspect, node, drift) in user-facing text
- When a rule blocks a change: translate why into business consequence

When reviewer rejects:
- Read its technical message (it's for you, not the user)
- Translate to user-facing explanation if surfaced to user

### Per-node artifacts: what they are for

Each node may have:

**`yg-node.yaml`** — identity and scope. Type, mapping, aspects, relations,
ports. Loaded by `yg context`. You consult this to know what aspects apply
and what files this node owns.

**`log.md`** — append-only history of WHY things happened in this node.
Read this BEFORE editing the node's source files. It contains:
- Business decisions with reasoning
- Constraints from external sources (regulations, contracts, SLA)
- Gotchas the next agent must know
- Why a feature is implemented the way it is

The log is for YOU (the agent). It is NOT visible to the reviewer that
verifies your code against aspects. Reviewer sees aspect content + source
files only. So log captures business context for agent decisions, but
enforcement remains aspect-based.

`yg context` does NOT include log content. Read it explicitly:
- `yg log read --node <path> --top 10` for recent entries (ergonomic, default top 10)
- `yg log read --node <path> --all` when you need the full history
- Read tool on `.yggdrasil/model/<path>/log.md` for full content when needed

### Log management

Every change to source files in a node's mapping requires a log entry
BEFORE running approve (for nodes whose type has `log_required: true`,
which is the default).

Workflow:

  1. Edit source files
  2. Run: yg log add --node <path> --reason "<justification>"
  3. Run: yg approve --node <path>

If you forget step 2: approve fails with clear error pointing you to fix.

If approve fails (reviewer rejects), you can iterate on the code without
adding new log entries. One log entry covers all source edits within a
single approve cycle (including failed approves and retries) until the
approve succeeds.

Log file format constraints (validated by yg check):
- Entry headers `## [<ISO datetime UTC with milliseconds>]` are reserved
- Sub-headings in your reason must be level 3+ (`###` or deeper)
- Do not put a level-2 heading (`##`) at the start of any line in your `--reason` content
  (UNLESS inside a fenced code block — those are allowed)
- Multi-line content via bash `$'multi\nline'` or via `--reason-file <path>`
  (cross-platform alternative; reads the entire file as the entry body)
- Datetimes must be strictly ascending across entries

Correcting a previous entry that turned out to be wrong:
- Append-only blocks editing historical entries
- Convention: start your correction entry with `### Supersedes: <prior ISO datetime>`
- Future agents reading the log will see structured supersedes

Recovery from typo in fresh entry (BEFORE first approve):

If you just ran `yg log add` and notice a typo in `--reason`, and no approve
has run since (drift state baseline still points to previous state):

  1. git checkout .yggdrasil/model/<path>/log.md
     (restores log.md to state before your typo entry)
  2. yg log add --node <path> --reason "<correct text>"

The drift state baseline is unchanged (no approve happened), so checking out
just log.md is safe and integrity remains intact. Do NOT use this path if
approve has already run on the typo'd entry — at that point the entry is
in the baseline and you must use the Supersedes convention instead.

Reverting a change you regret:
- Do NOT add a "correction" entry to log.md (would still leave wrong code)
- Use git: `git checkout <previous>` on source, log.md, AND drift state file:
  `git checkout HEAD~1 -- src/file.ts .yggdrasil/model/<path>/log.md .yggdrasil/.drift-state/<path>.json`
- Then: `yg log add --node <path> --reason "Tried X, reverted because Y"`
- Then: `yg approve --node <path>`

After a git merge: if both branches added log entries to the same node,
run `yg log merge-resolve --node <path>` from the merge commit. The tool
validates byte-exact ancestor portion and union of new entries — it cannot
silently drop or fabricate entries. Do NOT manually concatenate the two
log histories — integrity hashes will break and yg check fails.

Never edit log.md directly. Integrity verification will catch any
modification of historical entries (entries before the last approve).

When log.md is large (rough threshold: >50 entries OR >5000 tokens),
do not load full content into your context. Delegate to a subagent:

  Spawn subagent with: "Read .yggdrasil/model/<path>/log.md, summarize
  relevant context for task: <task description>. Return key decisions,
  constraints, and gotchas only."

Use the returned summary, not the full log.

`yg log add` does not trigger drift or run the reviewer. You can add
context entries between code changes freely. Only source file changes
in the mapping require entries paired with `yg approve`.

### Finding entry points

When a user request describes desired behavior:

  1. Translate keywords to English (Yggdrasil artifacts are English)
  2. Run: yg find "<keywords>"
  3. Read the top-ranked candidate's score critically:
     - Score >0.6: probably correct entry point
     - Score 0.3-0.6: maybe — verify with yg context
     - Score <0.3: weak match, consider fallback
  4. Use the `Kind` line to interpret the result:
     - `Kind: node` → strip `model/` prefix, use as `--node` value
     - `Kind: aspect` → read aspect file directly, not as node
  5. Run: yg context --node <node-path> for full context

If user request is cross-cutting (uses words "all", "every", "across"):
- Treat top 5 results as candidate SET
- Verify each via `yg impact`
- Consider whether the change should be a new aspect rather than per-node edit

If no good matches, fall back to `yg tree` for full graph overview, or
ask user for guidance.

If you decide the change is cross-cutting and should become a new aspect
(rather than per-node edit), follow the existing protocol from the
"When to Create Graph Elements" section (Aspect subsection). Note that
creating/modifying aspects (anything inside `.yggdrasil/`) does NOT require
log entries — log entries are required only for source files in node
mappings.

### Coordinated changes across multiple nodes

For changes that span multiple nodes (cross-cutting rename, schema migration,
shared concept update):

  1. Edit all affected source files first.
     Do NOT approve incrementally — risks half-applied state if one fails.

  2. Add log entry per affected node (each `yg log add --node X --reason "..."`
     for each node).
     One entry per node, even if the same business reason applies to many.

  3. Approve all nodes together using batch invocation:
     `yg approve --node A --node B --node C`
     Or use `yg approve --aspect <id>` / `--flow <name>` for aspect/flow-driven batches.

  4. Per-node independent execution:
     - Each node runs full algorithm (integrity, format, drift, mandatory, reviewer, commit).
     - One node failure does NOT abort others.
     - Output lists all results. Exit code 1 if ANY failed.

  5. On partial failure: fix per-node errors, re-run batch with only failed nodes.

  6. For node renames specifically:
     - Update `mapping:` w yg-node.yaml of affected nodes
     - Update `flows/<name>/yg-flow.yaml` `nodes:` lists referencing old names
     - `yg check` catches broken references; fix proactively

If user request is a rename, the rationale in `--reason` should explicitly
identify it as a cross-cutting rename to give future agents context.

### When to Create Graph Elements

**Aspect** — when the same pattern appears in 3+ files AND the reviewer can verify it against source code. Both conditions. "Every handler logs audit trail" — pattern + verifiable = aspect. "Code should be readable" — not verifiable, not an aspect. Read `schemas/yg-aspect.yaml` before creating. For reviewer choice (LLM vs AST): `yg knowledge read aspects-overview`. Content `.md` files state WHAT must be satisfied and WHY — use the user's words, never invent rationale. Things that do NOT become aspects: knowledge already visible in source code (imports, config), non-enforceable knowledge (business strategy, personas, pricing), and conventions the reviewer cannot check against code.

**Flow** — when you see a sequence of steps toward a business goal. Not code call sequences — real-world processes. "User places an order" = flow. "Handler calls service" = relation between nodes. Read `schemas/yg-flow.yaml` before creating.

**Node** — one per cohesive feature area. Not per directory, not per file. If a node would map >10 source files or cover >3 distinct workflows, split into children. Why: the reviewer sees ALL files in a node. Too many files = reviewer loses context and produces false rejections. Aim for 2-5 source files per node with aspects. Read `schemas/yg-node.yaml` before creating.

**Architecture change** — when existing types don't fit the project structure. Always confirm with the user. Never silently modify `yg-architecture.yaml`. If a relation between types is forbidden, present the constraint and let the user decide: use an allowed relation type, change the node type, or update the architecture.

**`when` predicate on an aspect or attach site** — when the aspect applies to
only a subset of nodes under a common attach channel. Prefer `when` over
splitting node types (proliferation of types). Prefer `when` over leaving
the decision to the reviewer textually inside `content.md`; `when` is
deterministic, has zero LLM cost, and keeps the graph as the source of
truth for applicability.

### Aspect Discovery

Aspects emerge from patterns — greenfield and brownfield:

- After working on 3+ files in the same area: are you applying the same pattern? If yes, create an aspect.
- Watch for "invisible" aspects: audit logging, webhook dispatch, auth guards, job dispatch — cross-cutting but easy to miss.
- Brownfield: same utility called in 3+ files = aspect waiting to be created.

### Delegating to Subagents

Subagents don't inherit Yggdrasil knowledge. First instruction in every subagent prompt:

```
BEFORE doing anything else: read .yggdrasil/agent-rules.md and follow its protocol.
DELIVERABLES — all required, incomplete work will be rejected:
  1. Working source code
  2. Graph nodes for every new/modified source file
  3. `yg check` passing
```

Code without graph updates = incomplete work.

### `yg-suppress` — Inline Aspect Waiver

Source code comments with `yg-suppress(<aspect-path>) <reason>` waive a specific aspect. The reviewer honors these unconditionally. Syntax: `yg knowledge read suppress-syntax`.

- You may propose a suppress when you see brownfield code or known tech debt violating an aspect
- You MUST NEVER write a suppress without explicit user confirmation — no exceptions
- Provide the correct aspect-path from graph context, ask the user for the reason
- You do not invent reasons — the user provides or approves them
- The marker applies contextually to surrounding code (function, class, block). At file level, it applies to the entire file.

### Escape Hatch

If the user explicitly requests a code-only change without graph updates: comply, but warn that this creates drift. `yg check` will catch it — and CI will block until it's resolved. Do not run `yg approve` — leave the drift visible.

### Working with architecture file

The architecture file (`.yggdrasil/yg-architecture.yaml`) defines node types,
allowed parents, default aspects, and the `when` predicate that classifies which
source files belong to each type.

BEFORE editing this file:
1. Read `schemas/yg-architecture.yaml` — full field reference and `when` predicate grammar.
2. Check impact: `yg impact --type <id>` for existing types.
3. Present the proposed change to the user and wait for confirmation before writing it.

If a new source file does not fit any type's `when`:
- Present the situation to the user — either extend the architecture (new type or
  broaden existing `when`), or accept the file as "uncovered" (warning, no enforcement).
  Do not silently create off-graph files.

Note: a node_type with `when` classifies files (forward — and optionally backward
with `enforce: strict`). A node_type without `when` is organizational — usable as a
parent in the hierarchy, but nodes of such types cannot have a non-empty `mapping:`.

### Where to find more

When you need to do X, run/read Y:

| Task | Resource |
|---|---|
| Edit `yg-architecture.yaml` | `schemas/yg-architecture.yaml` |
| Edit `yg-node.yaml` | `schemas/yg-node.yaml` |
| Edit `yg-flow.yaml` | `schemas/yg-flow.yaml` |
| Edit `yg-aspect.yaml` | `schemas/yg-aspect.yaml` |
| Edit `yg-config.yaml` | `schemas/yg-config.yaml` + `yg knowledge read configuration` |
| Pick the right type for new file | `yg knowledge read working-with-architecture` |
| Choose LLM vs AST reviewer | `yg knowledge read aspects-overview` |
| Write an LLM aspect | `yg knowledge read writing-llm-aspects` |
| Write an AST aspect | `yg knowledge read writing-ast-aspects` |
| Use `when` on an aspect | `yg knowledge read conditional-aspects` |
| Write `yg-suppress` in code | `yg knowledge read suppress-syntax` |
| Understand drift and cascade | `yg knowledge read drift-and-cascade` |
| Use CLI commands deep | `yg knowledge read cli-reference` |
| Browse available knowledge topics | `yg knowledge list` |

### Operational Notes

- English only for all files in `.yggdrasil/`. Conversation can be any language.
- Read the relevant schema from `schemas/` before creating any YAML file.
- When renaming or splitting a node: run `yg flows` and update any flow `nodes` lists that reference the old path. `yg check` will catch broken references but it's faster to fix them proactively.
- When unsure about anything: ask the user. Do not guess. Do not assume.
- Never invent rationale for aspects. If you don't know why a requirement exists, ask.

<!-- yggdrasil:end -->
