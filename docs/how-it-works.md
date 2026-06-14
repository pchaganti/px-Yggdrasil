---
title: How it works
---

You lay the track. Your agent drives. The reviewer keeps it on the rails.

The track is a set of rules and structure that live next to your code, in a `.yggdrasil/` directory in your repo. The rules say what your code must do — "every payment handler emits an audit event", "UI code never imports the database client". The agent writes code as usual. Before that code is considered done, the reviewer checks it against the rules and won't let the agent move on until it complies. When the agent drifts, the reviewer catches it and sends it back to fix course — in the same session, while the context is still fresh.

That's the whole idea. The rest of this page is the mental model behind it: who does what, and the loop they run.

## The three players

**You** say what matters, in plain language. "Services that touch money must log an audit trail." "Background jobs can't call the HTTP layer directly." You don't write YAML or wire up a graph by hand. You state the rule and the intent.

**Your agent** turns that into structure. It keeps the graph under `.yggdrasil/` in step with your code: it writes the rules down, says where each one applies, and records which source files belong to which component. You work *with* the agent to build and change this — it knows the schema and the commands; you provide the judgment.

**The reviewer** verifies the code. It's a separate step — either an LLM call that reads your rule and your source and decides whether the code satisfies it, or a free local script for rules that can be checked mechanically (an import ban, a naming convention). The reviewer is the thing that actually says yes or no.

## The loop

Here is the cycle, from the agent's point of view:

```text
before editing a file ─▶ yg context     (which rules touch this file?)
        │
        ▼
     write code
        │
        ▼
   yg check --approve  ─▶ free local checks first, then the LLM reviewer
        │
   ┌────┴─────┐
 pass        fail ─▶ specific feedback ─▶ agent fixes ─▶ re-run
   │
   ▼
   CI: yg check        (confirms recorded results)
```

**Before editing**, the agent runs `yg context --file <path>`. That hands it only the rules in force on that one file — not the whole rulebook. The agent reads those rules first, so it writes code that fits them instead of guessing and getting bounced.

**After editing**, the agent runs `yg check --approve`. This runs the free local script checks first, then sends the remaining rules to the LLM reviewer. A pass records the result. A failure comes back as specific feedback — which rule, which file, what's wrong — and the agent fixes it in the same session and re-runs.

**In CI**, you run plain `yg check`. It does not call the reviewer and needs no API keys. It only confirms that the results already recorded still hold for the current code. If a file changed but was never re-verified, `yg check` goes red and the build stops. The verification happens locally, while the agent works; CI just confirms it was done.

Verdicts are recorded so CI stays free and keyless — see [The lock](/the-lock) if you want the mechanics.

## You never trace the rules by hand

A file can pick up rules from several places at once — its own component, a parent component, its type, a flow it takes part in. You never work that out yourself by reading the graph. You ask the tool:

```bash
yg context --file src/payments/charge.ts
```

It prints every rule in force on that file and where each one came from, plus the path to each rule's text. The graph computes it; you read the answer. `yg context --node <path>` gives the same view from a component's side.

## What lives next to your code

Everything Yggdrasil needs sits in `.yggdrasil/`, committed alongside your source. Three kinds of thing matter day to day:

- **Aspects** — your rules. Each one is a plain-Markdown statement of what the code must do, checked by the reviewer. [Aspects](/aspects).
- **Nodes** — your components. Each maps a set of source files and lists the rules that apply to them. [Nodes](/nodes).
- **Flows** — your processes. A flow ties a set of components together as one business process so a shared rule applies across all of them. [Relations, flows, and ports](/relations-flows-ports).

A rule is just a few lines of Markdown:

```markdown
<!-- aspects/requires-audit/content.md -->
Every public mutation must emit an audit event before returning.

Use the shared auditLog.emit() utility — do not build custom audit logic.
The event must include: user ID, action, timestamp, affected resource ID.
```

The reviewer reads that and checks your code against it. Write rules the way you'd write a clear code-review comment.

Delete `.yggdrasil/` and your project builds and runs exactly as before. No build dependencies, no runtime hooks.

## Where next

- [Getting started](/getting-started) — install, init, and run the loop on a real repo.
- [Aspects](/aspects) — write your first rule.
