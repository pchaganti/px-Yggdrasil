---
title: Getting Started
---

## 1) Install

Requires Node.js 22+.

```bash
npm install -g @chrisdudek/yg
```

## 2) Init

```bash
cd your-project
yg init
```

The wizard asks two things:

1. **Which AI coding platform?** (Cursor, Claude Code, Copilot, etc.)
   This installs a rules file that teaches your agent the Yggdrasil protocol.
2. **Which reviewer provider?** (Anthropic, OpenAI, Google, Ollama, etc.)
   The wizard fetches available models, lets you pick one, and validates
   the connection.

That's it. Takes about a minute. The wizard creates `.yggdrasil/` with
config, schemas, architecture defaults, and the rules file for your platform.

The architecture file (`.yggdrasil/yg-architecture.yaml`) ships with an empty
architecture (`node_types: {}`) and commented examples — node types are defined
per project, not pre-configured. You add the types your project needs: define
new types, set default aspects per type, constrain relations. Tell the agent to
do it:

> "Add a node type 'api' with a default aspect 'requires-auth'."

If you selected an API provider, the wizard stores your API key in
`.yggdrasil/yg-secrets.yaml` (automatically gitignored). You can also
set keys via environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`) instead.

## 3) Your first aspect

After init, you have an empty graph. If you run `yg check` now, you'll see
all your source files listed as unmapped:

```text
$ yg check

my-project — 0 nodes, 0 aspects, 0 flows
Coverage: 0/50 source files (0%)

Errors (1):
  unmapped-files — 50 source files have no graph coverage.
```

This is expected. Tell your agent to create the first rule.

Example prompt:

> "Every service that handles payments must emit audit events.
> Create an aspect for this and apply it to the payments module."

The agent will create:

```text
.yggdrasil/
  aspects/
    requires-audit/
      yg-aspect.yaml       ← name + description
      content.md            ← the actual rule (plain Markdown)
  model/
    payments/
      yg-node.yaml          ← maps src/payments/, lists requires-audit aspect
```

Now run `yg check`:

```text
$ yg check

my-project — 1 nodes, 1 aspects, 0 flows
Coverage: 1/1 source files (100%)

Errors (1):
  unverified payments / requires-audit — no valid verdict
       This (aspect, node) pair has never been verified:
         src/payments/
       Verify it, then: yg check --approve

Result: FAIL (1 error, 0 warnings)
```

Check detected that the `requires-audit` rule on `src/payments/` has no recorded
verdict. The agent runs `yg check --approve` and the reviewer reads the source
code, checks it against the rules in `content.md`, and reports:

```text
$ yg check --approve

Filling 1 unverified pair across 1 node — 0 deterministic (no cost), 1 reviewer call.

  payments / requires-audit — SATISFIED

Result: PASS (verdict recorded in the lock)
```

If the code didn't satisfy the aspect, the output would show:

```text
  payments / requires-audit — REFUSED
    chargeCard() does not emit an audit event.
    No call to auditLog.emit() found in any mutation path.

Result: FAIL — fix the violation, then re-run: yg check --approve
```

The agent fixes the code and re-runs `yg check --approve` until all aspects pass.

**Tip — start new aspects at `status: advisory`.** A brand-new aspect on
an existing codebase often surfaces violations across many files.
Authoring the aspect with `status: advisory` runs the reviewer and lists
refusals as warnings — without blocking CI. Once the rule has been
exercised across the repo and the warnings are clean (or knowingly
accepted), promote to `status: enforced`. See
[Aspect Status](/aspect-status) for the full lifecycle.

## 4) Existing codebase (brownfield)

By default, `yg check` requires every git-tracked source file to belong to
some node. On a fresh repo with 200 files and 0 nodes, check fails
immediately.

You can relax this with a `coverage` block in `yg-config.yaml`. Files under
`coverage.required` roots remain blocking errors; files outside required (and
not excluded) become non-blocking warnings; files under `coverage.excluded`
are silent. Subtrees with their own nested `.yggdrasil/` are auto-skipped.
See [Configuration](/configuration) for details.

The fast path: **minimal nodes (no aspects) for everything you're not working
on, proper nodes with aspects for what you are.**

Tell your agent:

> "Create nodes without aspects for: src/legacy/, lib/, scripts/. Then create
> a proper node for src/payments/ with the requires-audit aspect."

Nodes without aspects are cheap — just a `yg-node.yaml` with a directory
mapping. They produce no pairs, so there is nothing to verify and nothing
to record. They count as covered for free.

When you start working on a covered area, add aspects to enforce rules.
This is how coverage naturally expands into enforcement as you work.

Practical steps for a 200-file repo:

1. Create 5-8 nodes without aspects for broad directory mappings
2. Create 1-2 nodes with aspects for your active work area
3. Run `yg check --approve` (aspect-less nodes produce no pairs, so the
   only cost is the reviewer pairs on your active work area)
4. `yg check` passes — CI is green
5. Add aspects to more nodes as you touch more code

## 5) CI integration

Add `yg check` to your CI pipeline. It recomputes the input hash of every
expected pair and compares it against the verdict recorded in the lock — no
LLM calls, no provider keys, runs instantly. Exit code 1 means a pair changed
without being re-verified.

**GitHub Actions:**

```yaml
- name: Check architecture
  run: npx @chrisdudek/yg check
```

If check fails, it means a pair's inputs changed without being re-verified.
Tell the agent: "resolve all yg check issues" and it will run `yg check
--approve`, fix violations, and re-verify until check passes.

## 6) Core vs. advanced — what to learn when

Yggdrasil has a lot of surface area, but you only need a few ideas to be
productive. Learn the rest the day you actually need it.

**Core — everything above this point.** Four concepts carry day-to-day work:

- **Node** — maps a set of source files (a `yg-node.yaml` with a `mapping:`).
- **Aspect** — one enforceable rule (`content.md` for the LLM reviewer, or
  `check.mjs` for a deterministic one).
- **`yg check`** — the gate. Hash-only, no LLM, no keys, runs in CI. Red
  until every changed pair is re-verified.
- **`yg check --approve`** — verifies the unverified pairs (deterministic for
  free, then LLM) and records the verdicts in the lock so check goes green.

Plus aspect **status** (`draft` → `advisory` → `enforced`) to control whether a
rule blocks. That is enough to enforce real rules on a real codebase.

**Advanced — reach for these only when a rule needs to scale past one node.**
Aspect inheritance through the node hierarchy, architecture type-defaults,
`implies` chains, flows, ports, and conditional `when` predicates all exist for
one purpose: applying a rule to many nodes **without** copy-pasting it onto each
one. You do not need any of them to start. When "every X must do Y" spans more
than a handful of files, that is the signal to read
[How it works](/how-it-works) and adopt one of these mechanisms.

**You never trace the cascade by hand.** No matter how many of those mechanisms
are in play, you do not work out which rules apply to a file by reading the
graph yourself. Ask the tool:

```bash
yg context --file src/payments/charge.ts
```

It prints every aspect effective on that file, **where each one came from**
(its own node, an ancestor, the architecture type, a flow, a port, or an
`implies` edge), and the `read:` path to each rule's text. The graph computes
the cascade; you read the answer. `yg context --node <path>` does the same from
a node's point of view.

Yggdrasil is zero lock-in. Delete `.yggdrasil/` and your project works
exactly as before. No build dependencies, no runtime hooks.

---

_Want to understand the model?_

- [How it works](/how-it-works) — the model: rails, the three players, the loop
- [Aspects](/aspects) — write your first rule
- [Nodes](/nodes) — group files into components
- [Configuration](/configuration) — reviewer setup, quality thresholds
- [CLI reference](/cli-reference) — all commands
