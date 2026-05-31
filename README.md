<p align="center">
  <img src="docs/public/demo.gif" alt="Yggdrasil review loop" width="900" />
</p>

# Yggdrasil

**Your agent will ignore CLAUDE.md. Yggdrasil makes sure it doesn't.**

Architecture rules your agent can't ignore. You write them in plain Markdown for a reviewer LLM to enforce, or as deterministic check scripts that run locally at zero LLM cost. Every change gets verified before the agent moves on. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more. The reviewer runs against your code, not your diffs. The feedback is specific. The agent has to fix before it can move on.

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Stars](https://img.shields.io/github/stars/krzysztofdudek/Yggdrasil)](https://github.com/krzysztofdudek/Yggdrasil)
[![GitHub Discussions](https://img.shields.io/badge/Discussions-Join-181717?logo=github&logoColor=white)](https://github.com/krzysztofdudek/Yggdrasil/discussions)

---

I built this after watching Claude Code quietly skip audit logging on a payment mutation for the third time. CLAUDE.md said to emit audit events. The agent read it. The agent ignored it. Tests passed. Lint passed. I only caught it because I happened to diff that specific file.

A rules file is a suggestion. This is the reviewer that turns it into a rule.

## The problem

You wrote 200 lines of rules in CLAUDE.md or .cursorrules. Your agent applies maybe 70% of them. The rest it "optimizes away" because it decided they're noise. You tell it again, it does better for a while. Next session, same thing.

Tests pass. Lint passes. The code compiles. But the agent skipped audit logging on a payment mutation, called a service it shouldn't from that layer, used `Date.now()` in a module that must be deterministic.

You find out when you review a PR with 50 changed files. Or you don't.

A rules file is a suggestion. There are no consequences for ignoring it, and no feedback until it's too late.

## What Yggdrasil does

The architecture lives in a graph next to the code, under `.yggdrasil/`. It has three first-class elements:

- **Nodes** group source files into components.
- **Aspects** are the rules attached to nodes ("Every public endpoint must use rate limiting", "All command handlers must validate input with zod", "No direct database access from this layer").
- **Flows** mark business processes that span components; an aspect on a flow reaches every participant.

**Ports** carry an aspect across a component boundary. A bare relation between nodes does not propagate aspects — only consuming a named port does, which keeps inheritance explicit rather than accidental.

Every aspect declares a reviewer type:

- **LLM aspects** are plain Markdown (`content.md`). A separate LLM call — one model verifying another — reads the rule and the node's source, then returns SATISFIED or NOT SATISFIED.
- **Deterministic aspects** ship a `check.mjs` that the CLI runs locally at zero LLM cost. These come in two styles: *single-file* checks that walk a tree-sitter parse tree (TypeScript/JavaScript), and *graph-aware* checks that are language-agnostic and operate on the node, its files, the file system, and the full graph topology. The two styles are mutually exclusive with `content.md` — an aspect is one or the other.

Before the agent edits a file, `yg context` returns the aspects that touch it (as `read:` pointers the agent opens individually, not an inline dump). The agent writes code that targets them. After editing, `yg approve` records a new baseline: LLM aspects go to the reviewer, deterministic aspects run locally. If anything fails, the agent gets specific feedback, fixes, and re-verifies. This is code review while the agent is working, not after.

```
agent about to edit a file
  → yg context: the aspects that touch this file
  → agent writes code that targets them
  → yg log add: record why this change happened
  → yg approve: reviewer checks LLM aspects, check.mjs runs locally for deterministic ones
  → reviewer: "audit logging missing in charge()"
  → agent fixes, re-runs approve
  → baseline recorded
  → yg check in CI: PASS (hash comparison, no LLM calls)
```

Aspects are scoped. The agent only sees the ones that touch the file it's working on, not all 200. One aspect can cover dozens of files. Change an aspect and every file that should satisfy it gets flagged for re-verification.

How aspects reach a node is itself a graph computation. An aspect can arrive through any of **seven channels** — declared on the node, inherited from an ancestor, applied as an architecture default for the node's type (or an ancestor type), propagated from a flow, required by a consumed port, or pulled in by another aspect's recursive `implies` chain. The effective set is the union across all of them.

### Status: draft, advisory, enforced

Every aspect has a status that controls whether the reviewer runs and how a refusal surfaces:

| Status | Reviewer runs? | Refusal | Blocks `yg check` / CI |
|---|---|---|---|
| `draft` | no | skipped, no verdict, no cost | no |
| `advisory` | yes | warning | no |
| `enforced` (default) | yes | error | yes |

A typical lifecycle is draft while you author the rule, advisory for a sprint or two to gather signal without blocking anyone, then enforced once you trust it. Status can be declared at several attach sites (the aspect itself, a per-node entry, an architecture type, a flow, a port); the effective status is the strictest one — bumping up is allowed, downgrading is a validator error.

### When you need finer control

- **Conditional aspects.** A `when` predicate filters applicability per node, deterministically, before the reviewer is ever invoked — over relations, descendants, ports, and node type. If it evaluates false, the aspect is invisible on that node: no cost, no display, no verdict.
- **Tiers and consensus.** LLM aspects pick a named tier in `yg-config.yaml` that pins a provider, model, temperature, and endpoint. A tier can set `consensus` to a positive odd number to run the reviewer N times and take the majority vote for high-stakes rules (cost multiplies accordingly). Deterministic aspects must not set a tier.

Each node also has an append-only `log.md` under its model directory (next to `yg-node.yaml`). The agent records *why* a change happened via `yg log add` and reads prior entries with `yg log read` — when a node's type requires it (the default), `yg approve` won't record a baseline until a fresh log entry exists for the change. The log carries intent between sessions. The reviewer doesn't see it. The next agent does.

When a genuine exception is needed, an inline `yg-suppress(<aspect-path>) <reason>` waiver can exempt a specific location — used sparingly, and only with your explicit sign-off.

## Works on any codebase

**New project:** define rules before writing code. The agent builds the graph structure as it implements features. Every new file is verified from the start.

**Existing project:** map the areas you're actively working on. Everything else stays unmapped until you need it. Coverage grows as you work, not as a day-one setup cost.

## Rules can be anything enforceable

Team conventions. Company standards. ISO compliance. Architecture boundaries. Error handling patterns. Logging formats. If you can describe it in plain language and a reviewer can check it — or express it as a deterministic script — Yggdrasil enforces it.

## The Yggdrasil family

Four tools, one thesis: **make an AI coding agent prove correctness, stage by stage** — because "done" isn't done. Each is a checkpoint at a different point in the pipeline. Yggdrasil enforces architecture against the codebase itself; the other three are single Markdown files (installable as a Claude Code plugin or droppable into any agent that reads skills) that check the earlier stages.

| Tool | Stage | What it makes the agent prove |
|---|---|---|
| **Yggdrasil** (this one) | code → architecture | Every change satisfies the rules that govern it, checked before the agent moves on. |
| **[Ratatoskr](https://github.com/krzysztofdudek/RatatoskrSkill)** | request → intent | Reads your request back in plain words and waits for an explicit yes before it acts. |
| **[Urd](https://github.com/krzysztofdudek/UrdSkill)** | intent → code | When the spec is ambiguous, it consults the source of truth and asks — it doesn't guess. |
| **[Researcher](https://github.com/krzysztofdudek/ResearcherSkill)** | code → measured result | Point it at a metric and it runs experiments — hypotheses kept and discarded. |

## Getting started

**1. Install and init.** Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

The wizard walks you through platform selection and reviewer setup (provider, model, and where keys live in `yg-config.yaml` / `yg-secrets.yaml`).

**2. Tell the agent what matters.**

```
You:    "All payment operations must emit audit events."
Agent:  Creates rule, applies it to payment code.

You:    "All API endpoints must validate input with zod."
Agent:  Creates rule, applies it to endpoint handlers.
```

The agent manages the structure. Which rules apply where, which files are mapped, how components relate. You say what should be enforced.

**3. Work normally.**

The agent verifies its own code as it works. When it violates a rule, it gets feedback and fixes it.

**4. Enforce in CI.**

```yaml
- run: npx @chrisdudek/yg check
```

`yg check` is the deterministic gate: it makes no LLM calls. It compares file hashes against the recorded baseline and also validates structure, schema, coverage, and completeness. If code changed without being verified, it fails.

## Supported platforms

Works with any AI coding agent. `yg init` sets up the rules file your agent expects and configures the reviewer.

**Agent platforms:** Cursor, Claude Code, GitHub Copilot, Codex, Cline, RooCode, Windsurf, Aider, Gemini CLI, Amp, OpenCode, CodeBuddy, plus a Generic fallback (`.yggdrasil/agent-rules.md`) for anything not listed. Codex, Amp, and OpenCode all write to a shared `AGENTS.md`, so don't initialize more than one of them at once.

**Reviewer providers:**

- **API:** Anthropic, OpenAI, Google, OpenAI-compatible (require an API key)
- **Local:** Ollama (no API cost; requires a local install)
- **Agent CLI:** Claude Code, Codex, Gemini CLI (delegate to the installed CLI; no API key)

## CLI

`yg` is the single binary. The commands the agent (and you) use most:

- `yg context --file <path>` / `--node <path>` — the aspects effective on a file or node, before editing.
- `yg approve --node <path>` (repeatable) `[--aspect <id>] [--flow <name>] [--dry-run]` — review and record a baseline.
- `yg check` — the deterministic CI gate (drift, structure, coverage, completeness; no LLM calls).
- `yg log add | read | merge-resolve` — the per-node decision log.
- `yg impact`, `yg tree`, `yg find`, `yg aspects`, `yg flows`, `yg owner`, `yg type-suggest` — navigate and query the graph.
- `yg knowledge list | read <name>` — the built-in reference topics (aspects, status, conditional aspects, ports, flows, deterministic checks, and more).
- `yg deterministic-test` — run a `check.mjs` against specific files without attaching it to the graph.

## FAQ

**How is this different from CLAUDE.md or .cursorrules?**
Rules files are flat text dumped into every prompt. No scoping, no verification. Yggdrasil delivers only the rules relevant to each file and reviews the output against them.

**How is this different from linters?**
Linters check syntax and patterns. "Rate limiting required" isn't a lint rule. "No direct DB access from this layer" isn't in any AST. "All mutations must emit audit events" can't be checked with regex. Yggdrasil reviews against rules that only exist in your head until you write them down — and where a rule *is* mechanically checkable, you can write it as a deterministic check that runs for free.

**How is this different from a PR review?**
PR review happens after the code is written. By then the agent has moved on, context is lost, and you're catching up. Yggdrasil reviews while the agent is working, so violations get fixed in the same session.

**Does it work?**
Locally, `yg approve` sends LLM aspects to the reviewer and runs deterministic aspects on your machine, then records a baseline. `yg check` in CI makes no LLM calls — it compares file hashes against that baseline (and validates structure and coverage). If a PR has unverified changes, CI catches it.

**What if I want to stop?**
Delete `.yggdrasil/` and the rules file. No runtime dependencies, no build hooks, nothing left behind.

**Is this just another AI code review bot?**
No. AI code review bots scan diffs for bugs after the fact. Yggdrasil runs a reviewer against specific rules you wrote, inside the agent's loop, so violations get fixed in the same session rather than piling up in a PR that nobody has time to read. The rules are yours; the enforcement is what Yggdrasil adds.

## Examples

[`examples/`](examples/) has two projects you can run. One passes, one has a deliberate violation for the reviewer to catch.

This repo uses Yggdrasil on itself. Browse [`.yggdrasil/`](.yggdrasil/) for a real, live graph, or run `yg check` in a clone to see the current node and aspect coverage for yourself.

## Docs

[krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/)

## License

MIT

---

<div align="center">
  <img src="docs/public/logo.svg" alt="Yggdrasil" width="150" />
  <br/><br/>
  <a href="https://github.com/krzysztofdudek/Yggdrasil/discussions">
    <img src="https://img.shields.io/badge/Discussions-Join-181717?logo=github&logoColor=white" alt="GitHub Discussions" />
  </a>
  <br/>
  <sub>Questions? Open a discussion on GitHub.</sub>
</div>
