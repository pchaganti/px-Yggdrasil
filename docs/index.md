---
layout: home
title: Yggdrasil
hero:
  name: Yggdrasil
  text: Rules your agent can't drive around.
  tagline: Your agent reads your rules file and applies maybe 70% of it. Yggdrasil makes sure it doesn't.
  image:
    src: /logo.svg
    alt: Yggdrasil
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: How it works
      link: /how-it-works
features:
  - title: Only the rules that matter, every time
    details: Before the agent edits a file, it gets the handful of rules that touch that file — not a 200-line dump it half-ignores.
  - title: Caught before it moves on
    details: Every change is reviewed before the agent continues — by an LLM, or a free local script. Violations have to be fixed to proceed.
  - title: CI stays green without keys
    details: Each verdict is recorded once. CI just rechecks the records — no LLM calls, no provider keys, runs instantly.
---

Your agent reads `CLAUDE.md` or `.cursorrules` and applies maybe 70% of it. Tests pass, lint passes, the code compiles — but it skipped the audit log on a payment mutation, or called a service it shouldn't from that layer. A rules file is a suggestion. There are no consequences for ignoring it, and no feedback until you're reviewing a PR with 50 changed files.

You lay the track, the agent drives, the reviewer keeps it on the rails. You write the rules and the structure next to your code. The agent does the work. A reviewer checks each change and makes the agent fix course before it moves on.

```text
agent about to edit a file
  → yg context: only the rules that touch this file
  → agent writes code that targets them
  → yg check --approve: free scripts run first, then the LLM reviewer
  → reviewer: "audit logging missing in charge()"
  → agent fixes, re-runs
  → verdict recorded
  → CI: yg check — no LLM, no keys
```

A rule is plain Markdown. You write what must be true and why; the reviewer reads it and checks your code against it.

```markdown
# Audit logging on payment mutations

Every function that changes a payment record must emit an audit
event before returning. Look for a call to `auditLog.emit()` on
every path that writes to the payments store.
```

[Get Started](/getting-started) — set up your first verified rule. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more.
