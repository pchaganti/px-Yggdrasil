<p align="center">
  <img src="docs/public/demo.gif" alt="Yggdrasil review loop" width="900" />
</p>

# Yggdrasil

**Stop babysitting your agent.**

Your architecture rules become checks it can't skip, run on every change before it moves on. A script runs them locally for free, or an LLM reviews the call a script can't make. Checks run against your code, not your diffs. The feedback is specific, and the agent has to fix before it can move on. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more.

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

You lay the track: rules and structure that live in a graph next to your code, under `.yggdrasil/`. The agent drives — it writes the code. A reviewer keeps it on the rails: it checks each change against your rules and makes the agent fix course before it moves on.

The graph has three first-class elements:

- **Nodes** group source files into components.
- **Aspects** are the rules attached to nodes ("Every public endpoint must use rate limiting", "All command handlers must validate input with zod", "No direct database access from this layer").
- **Flows** mark business processes that span components; an aspect on a flow reaches every participant.

A rule can apply to one component or many. You attach it once; the tool computes everywhere it lands. You never copy-paste a rule onto each file — see the [docs](https://krzysztofdudek.github.io/Yggdrasil/) for how that works. **Ports** are the one explicit exception: a bare relation between nodes does not carry an aspect across a component boundary, but consuming a named port does. That keeps inheritance deliberate, never accidental.

Every aspect names its reviewer — and the two are not equal:

- **Deterministic aspects** ship a `check.mjs` that the CLI runs locally at zero LLM cost. It reads the node's source (with a tree-sitter parse tree where the language has a grammar), the file system, and the graph, and returns a list of violations. This is the un-ignorable layer: the script *runs*, every time, deterministically, for free — exactly the kind of rule an agent quietly drops when it's only a line in CLAUDE.md. A built-in check of the same kind keeps your declared component dependencies honest against the real code. Lean on this layer.

- **LLM aspects** are plain Markdown (`content.md`) — for the judgment a script can't make. A separate LLM call — one model verifying another — reads the rule and the node's source, then returns SATISFIED or NOT SATISFIED. It is the higher-variance layer: reserve it for rules that genuinely need reading, keep those nodes small, and stage new ones through `advisory` before you enforce. The rule is just text you write:

  ```markdown
  # Audit every payment mutation

  Any function that creates, updates, or refunds a charge must
  call `auditLog.emit()` before it returns. A mutation with no
  audit event is a refusal.
  ```

An aspect is one or the other, never both.

Before the agent edits a file, `yg context` returns the aspects that touch it — the agent opens each rule's text and writes code that targets it. After editing, `yg check --approve` verifies everything whose inputs changed: deterministic checks run locally for free, LLM rules go to the reviewer. Each verdict is recorded in a single committed lock file. If anything fails, the agent gets specific feedback, fixes, and re-verifies. This is code review while the agent is working, not after.

```
agent about to edit a file
  → yg context: the aspects that touch this file
  → agent writes code that targets them
  → yg log add: record why this change happened
  → yg check --approve: deterministic checks run locally, LLM aspects go to the reviewer
  → reviewer: "audit logging missing in charge()"
  → agent fixes, re-runs check --approve
  → verdict recorded in the lock
  → yg check in CI: PASS (recomputes input hashes, no LLM calls)
```

Aspects are scoped. The agent only sees the ones that touch the file it's working on, not all 200. One aspect can cover dozens of files. Change an aspect and everything it governs gets flagged for re-verification.

### Status: draft, advisory, enforced

Status controls how loud a rule is, not what it checks. A `draft` aspect is silent while you author it. An `advisory` aspect runs the reviewer and lists problems as warnings — useful for a sprint or two to gather signal without blocking anyone. An `enforced` aspect blocks `yg check` and CI. Verdicts survive status flips, so promoting advisory → enforced never re-runs the reviewer. See [Aspect Status](https://krzysztofdudek.github.io/Yggdrasil/aspect-status) for the lifecycle.

### When you need finer control

A `when` predicate makes an aspect apply to only a subset of nodes — checked deterministically, before the reviewer is ever called. LLM aspects can pin a named tier (provider, model, temperature) and run the reviewer multiple times to take a majority vote on high-stakes rules. Both are reference-level; see the [docs](https://krzysztofdudek.github.io/Yggdrasil/).

Each node also keeps an append-only `log.md` next to its `yg-node.yaml`. The log captures *why* a change happened — the intent the diff never records. The agent writes entries with `yg log add` and reads prior ones with `yg log read`. A node type can require a fresh entry before a source change is verified. The reviewer never sees the log; the next agent does.

When a genuine exception is needed, an inline `yg-suppress(<aspect-path>) <reason>` waiver exempts a specific location — used sparingly, and only with your explicit sign-off.

## Works on any codebase

**New project:** define rules before writing code. The agent builds the graph structure as it implements features. Every new file is verified from the start.

**Existing project:** map the areas you're actively working on. Everything else stays unmapped until you need it. Coverage grows as you work, not as a day-one setup cost.

## Rules can be anything enforceable

Team conventions. Company standards. ISO compliance. Architecture boundaries. Error handling patterns. Logging formats. If you can describe it in plain language and a reviewer can check it — or express it as a script — Yggdrasil enforces it.

Two honest limits. A rule enforces **structure, not runtime behavior**: it can require that you call the audit utility, not that the audit actually fires in production. And a green check is only as good as the rule behind it — a shallow rule passes shallow code. The enforcement is real; deciding what is worth enforcing stays yours.

## The Yggdrasil family

Four tools, one thesis: **make an AI coding agent prove correctness, stage by stage** — because "done" isn't done. Each is a checkpoint at a different point in the pipeline. Yggdrasil enforces architecture against the codebase itself; the other three are single Markdown files (installable as a Claude Code plugin or droppable into any agent that reads skills) that check the earlier stages.

| Tool | Stage | What it makes the agent prove |
|---|---|---|
| **Yggdrasil** (this one) | code → architecture | Every change satisfies the rules that govern it, checked before the agent moves on. |
| **[Ratatoskr](https://github.com/krzysztofdudek/RatatoskrSkill)** | request → intent | Reads your request back in plain words so you see what it understood before it builds. |
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

`yg check` is the deterministic gate: it makes no LLM calls and needs no provider config or keys. It recomputes the input hash of every expected pair and compares it against the verdict recorded in the lock, and also validates structure, coverage, and completeness. If code changed without being verified, the pair no longer matches its recorded hash and check fails.

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
- `yg check` — the deterministic CI gate (verifies recorded verdicts by hash, plus structure, coverage, completeness; no LLM calls, no keys).
- `yg check --approve` — verify every unverified pair (deterministic first, for free; then LLM) and record the verdicts in the lock.
- `yg aspect-test` — run an aspect of either kind against a node or files on demand, including an LLM `--dry-run` prompt preview; never writes the lock.
- `yg log add | read | merge-resolve` — the per-node decision log.
- `yg impact`, `yg tree`, `yg find`, `yg aspects`, `yg flows`, `yg owner`, `yg suppressions`, `yg type-suggest` — navigate and query the graph.
- `yg knowledge list | read <name>` — the built-in reference topics (aspects, ports and relations, flows, the lock, and more).

## FAQ

**How is this different from CLAUDE.md or .cursorrules?**
Rules files are flat text dumped into every prompt. No scoping, no verification. Yggdrasil delivers only the rules relevant to each file and reviews the output against them.

**How is this different from linters?**
Linters check syntax and patterns. "Rate limiting required" isn't a lint rule. "No direct DB access from this layer" isn't in any AST. "All mutations must emit audit events" can't be checked with regex. Yggdrasil reviews against rules that only exist in your head until you write them down — and where a rule *is* mechanically checkable, you can write it as a script that runs for free.

**How is this different from a PR review?**
PR review happens after the code is written. By then the agent has moved on, context is lost, and you're catching up. Yggdrasil reviews while the agent is working, so violations get fixed in the same session.

**Does it work?**
Locally, `yg check --approve` sends LLM aspects to the reviewer and runs script aspects on your machine, then records each verdict in a single committed lock file. `yg check` in CI makes no LLM calls — it recomputes the input hash of every expected pair and compares it against the verdict the lock recorded (and validates structure and coverage). If a PR has unverified changes, the hashes no longer match and CI catches it.

**What if I want to stop?**
Delete `.yggdrasil/` and the rules file. No runtime dependencies, no build hooks, nothing left behind.

**Is this just another AI code review bot?**
No. AI code review bots scan diffs for bugs after the fact. Yggdrasil runs a reviewer against specific rules you wrote, inside the agent's loop, so violations get fixed in the same session rather than piling up in a PR that nobody has time to read. The rules are yours; the enforcement is what Yggdrasil adds.

## Examples

[`examples/`](examples/) has two projects you can run. One passes, one has a deliberate violation for the reviewer to catch.

This repo uses Yggdrasil on itself. Browse [`.yggdrasil/`](.yggdrasil/) for a real, live graph, or run `yg check` in a clone to see the current node and aspect coverage for yourself.

## Docs

[krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/) — start with [How it works](https://krzysztofdudek.github.io/Yggdrasil/how-it-works), then [Getting started](https://krzysztofdudek.github.io/Yggdrasil/getting-started).

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
