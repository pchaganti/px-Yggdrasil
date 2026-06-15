---
title: The lock
---

This is the depth page. Day to day you never touch the lock — your agent runs `yg check` and `yg check --approve`, and the lock takes care of itself. Read this when you want to know exactly how a verdict is stored, when it expires, and why CI can recheck your whole repo without an API key.

The payoff is simple: every verdict is recorded once, in one committed file, `.yggdrasil/yg-lock.json`. Because the file is committed, CI doesn't re-run the reviewer — it recomputes a hash and confirms the recorded verdicts still match the current code. Fast, keyless, and it travels with the repo.

Everything below names the machinery. The concept pages [/aspects](/aspects), [/nodes](/nodes), and [/relations-flows-ports](/relations-flows-ports) deliberately leave it out so you can start without it.

## Pairs and units

Verification runs per **pair**: one `(aspect, unit)`.

A **unit** is what a single verification covers. The aspect's `scope` sets it:

- `per: node` (the default) — the unit is the whole node. One verdict over all the node's mapped files.
- `per: file` — the unit is a single mapped file. One verdict each.

So a `per: node` aspect on a node with five files is one pair. The same aspect set to `per: file` over those five files is five pairs. Pairs are the unit of cost and caching: one lock entry per pair.

## What makes a verdict valid

Each entry stores the verdict and a hash of the inputs that produced it. The verdict is valid exactly while those inputs still hash to the stored value. Recompute the hash, compare — match means valid, mismatch means the pair is **unverified** again.

What the hash folds depends on the reviewer kind:

- **LLM pair** — the rule text (`content.md`), the subject files, the aspect description, any reference files, and the resolved reviewer tier.
- **Deterministic pair** — the rule (`check.mjs`), the subject files, and everything the check observed beyond those files: each file it read, each directory it listed, each existence probe (including the ones that came back `false`), and each piece of graph topology it looked at.

Change any folded input and the pair goes unverified. Edit a source file, edit the rule, change the tier, move a file the check was watching — all of these. The next `yg check --approve` re-verifies them.

One thing is deliberately **not** an input: the aspect's status. Flipping `draft ↔ advisory ↔ enforced` changes how a verdict renders, never whether it's valid. A verdict survives every status flip, including a full `draft` round-trip. See [/aspect-status](/aspect-status).

## `yg check` vs `yg check --approve`

These are two different jobs.

`yg check` writes nothing. It recomputes each pair's input hash and compares it against the lock. It runs no aspect reviewers, makes no LLM calls, and needs no provider keys — which is why it's the CI gate. (It does recompute relation conformance live; see below.) A mismatch means a pair changed without being re-verified, and check reports it.

`yg check --approve` is the only command that writes verdicts. It fills every unverified pair: deterministic checks first (they run locally, for free), then the LLM pairs. When a pair gets a real verdict — pass or refusal — the entry lands in the lock. Then it reports, just like a plain check.

A failed pair never blocks the others. `--approve` records every result it gets and exits non-zero if any error remains.

## Refusals are cached

A refusal is a verdict, and it's cached like any other. For unchanged inputs it's **final** — re-running `yg check --approve` over a refused pair does not re-run the reviewer. For a deterministic check a re-run would return the same violations; for an LLM check it would be a re-roll of a judgment that already came back negative. There is deliberately no force-rejudge command.

There are exactly three ways out of a refusal:

1. **Fix the code.** This changes a subject file, which invalidates the pair, which re-verifies it.
2. **Sharpen the rule.** Editing `content.md` changes the rule hash and re-verifies **every** pair of that aspect — possibly many nodes. Run `yg impact --aspect <id>` first to see the count.
3. **`yg-suppress`, with your sign-off.** A documented file-level waiver for known debt. See [/reviewers](/reviewers).

A cosmetic edit to the rule or the source — a reworded comment, a whitespace change — would also re-roll the verdict. Don't. That is exactly the laundering the missing force command refuses to offer.

## The relation check is not in the lock

Alongside the aspect reviewers, every `yg check` runs one built-in check that confirms every real code dependency is declared as a relation. It's deterministic, but unlike an aspect verdict it is **never stored in the lock** — there is no relation verdict, no hash, and no section for it.

Instead it is recomputed live on every run, plain `yg check` and `yg check --approve` alike: the pass parses each mapped source file, resolves every statically-resolvable cross-node dependency, and checks it against the node's declared relations, from scratch. Because nothing is cached, it can never go stale and never needs re-validation — the result is always the current truth of your code against the graph, at zero LLM cost.

That is also why a keyless CI `yg check` catches an undeclared dependency: it makes no LLM calls and reads no verdict for this check, yet it still parses and resolves live. For what it detects and how to clear a refusal, see [/relations-flows-ports](/relations-flows-ports).

## Merge conflicts

When two branches both wrote verdicts, git can leave conflict markers in `yg-lock.json`. Do not hand-stitch the two sides. Pick one side wholesale:

```bash
git checkout --ours -- .yggdrasil/yg-lock.json    # or --theirs
yg check --approve
```

Prefer the side that covers more of the merged code, to minimize re-verification. This is safe because the lock is self-validating: a verdict you kept by accident can't lie — its hash won't match the current inputs, so it re-verifies. The discarded side's verdicts are simply re-filled on that run.

Hand-merging entry by entry is the one thing to avoid. A duplicate key or a stray conflict marker makes the whole file invalid, and Yggdrasil fails closed rather than trust a damaged lock.
