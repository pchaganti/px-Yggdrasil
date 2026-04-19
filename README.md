<p align="center">
  <img src="docs/public/demo.gif" alt="Yggdrasil review loop" width="900" />
</p>

# Yggdrasil

**Your agent will ignore CLAUDE.md. Yggdrasil makes sure it doesn't.**

An LLM reviewer that enforces your architecture rules on every change your coding agent makes — Claude Code, Cursor, Copilot, Codex, Cline. If the code violates a rule, the agent gets specific feedback and has to fix it before moving on. Review happens in the loop, not after on a PR.

[![CI](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml/badge.svg)](https://github.com/krzysztofdudek/Yggdrasil/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@chrisdudek/yg.svg)](https://www.npmjs.com/package/@chrisdudek/yg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![codecov](https://codecov.io/gh/krzysztofdudek/Yggdrasil/graph/badge.svg)](https://codecov.io/gh/krzysztofdudek/Yggdrasil)
[![GitHub Stars](https://img.shields.io/github/stars/krzysztofdudek/Yggdrasil)](https://github.com/krzysztofdudek/Yggdrasil)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/SZTbgsH8Wm)

---

I built this after watching Claude Code quietly skip audit logging on a payment mutation for the third time. CLAUDE.md said to emit audit events. The agent read it. The agent ignored it. Tests passed. Lint passed. I only caught it because I happened to diff that specific file.

A rules file is a suggestion. This is the reviewer that turns it into a rule.

## The problem

You wrote 200 lines of rules in CLAUDE.md or .cursorrules. Your agent applies maybe 70% of them. The rest it "optimizes away" because it decided they're noise. You tell it again, it does better for a while. Next session, same thing.

Tests pass. Lint passes. The code compiles. But the agent skipped audit logging on a payment mutation, called a service it shouldn't from that layer, used `Date.now()` in a module that must be deterministic.

You find out when you review a PR with 50 changed files. Or you don't.

A rules file is a suggestion. There are no consequences for ignoring it, and no feedback until it's too late.

## What Yggdrasil does

You write rules in plain Markdown. "Every public endpoint must use rate limiting." "All command handlers must validate input with zod." "No direct database access from this layer." These are called **aspects**.

Every time the agent writes code, it runs `yg approve`. A reviewer LLM reads the source files and checks them against every rule that applies. If something doesn't pass, the agent gets specific feedback, fixes it, and re-verifies. This is code review while the agent is working, not after.

```
agent writes code
  → yg approve sends code + rules to reviewer
  → reviewer: "audit logging missing in charge()"
  → agent fixes, re-runs approve
  → all rules satisfied
  → yg check in CI: PASS
```

Rules are scoped. The agent sees only the 3-5 rules relevant to the file it's working on, not all 200. One rule can cover dozens of files. Change a rule, every file that should satisfy it gets flagged for re-verification.

## Works on any codebase

**New project:** define rules before writing code. The agent builds the graph structure as it implements features. Every new file is verified from the start.

**Existing project:** map the areas you're actively working on. Everything else stays unmapped until you need it. Coverage grows as you work, not as a day-one setup cost.

## Rules can be anything enforceable

Team conventions. Company standards. ISO compliance. Architecture boundaries. Error handling patterns. Logging formats. If you can describe it in plain language and a reviewer can check it, Yggdrasil enforces it.

## Getting started

**1. Install and init.** Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

The wizard walks you through platform selection and reviewer setup.

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

No LLM calls in CI. Pure hash comparison. If code changed without being verified, it fails.

## Supported platforms

Works with any AI coding agent. `yg init` sets up the rules file your agent expects.

**Agent platforms:** Cursor, Claude Code, GitHub Copilot, Codex, Cline, RooCode, Windsurf, Aider, Gemini CLI, Amp, OpenCode, CodeBuddy

**Reviewer providers:** API (Anthropic, OpenAI, Google, OpenAI-compatible, Ollama) or agent CLI (Claude Code, Codex, Gemini CLI).

## FAQ

**How is this different from CLAUDE.md or .cursorrules?**
Rules files are flat text dumped into every prompt. No scoping, no verification. Yggdrasil delivers only the rules relevant to each file and reviews the output against them.

**How is this different from linters?**
Linters check syntax and patterns. "Rate limiting required" isn't a lint rule. "No direct DB access from this layer" isn't in any AST. "All mutations must emit audit events" can't be checked with regex. Yggdrasil reviews against rules that only exist in your head until you write them down.

**How is this different from a PR review?**
PR review happens after the code is written. By then the agent has moved on, context is lost, and you're catching up. Yggdrasil reviews while the agent is working, so violations get fixed in the same session.

**Does it work?**
`yg check` in CI compares file hashes. No LLM calls, pure hash comparison. If source files changed without being verified, check fails. Locally, `yg approve` sends code to the reviewer LLM. If a PR has unverified changes, CI catches it.

**What if I want to stop?**
Delete `.yggdrasil/` and the rules file. No runtime dependencies, no build hooks, nothing left behind.

## Examples

[`examples/`](examples/) has two projects you can run. One passes, one has a deliberate violation for the reviewer to catch.

This repo uses Yggdrasil on itself. Browse [`.yggdrasil/`](.yggdrasil/) for a real graph with 55 nodes, 7 aspects, 7 flows, 100% coverage.

## Docs

[krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/)

## License

MIT

---

<div align="center">
  <img src="docs/public/logo.svg" alt="Yggdrasil" width="150" />
  <br/><br/>
  <a href="https://discord.gg/SZTbgsH8Wm">
    <img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white" alt="Discord" />
  </a>
  <br/>
  <sub>Questions? Join the Discord.</sub>
</div>
