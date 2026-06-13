export const summary =
  'The verdict lock: format, pairs/units, hash ingredients + exclusions + observation fold, caching policy (refusals final, three exits), merge procedure, garbage-collection, revert recipe, park-with-draft';

export const content = `# Verification and the lock

Every verdict — an LLM reviewer's judgment and a deterministic check's result
alike — is stored as a content-addressed entry in one committed file,
\`.yggdrasil/yg-lock.json\`. A verdict is valid exactly while the inputs that
produced it hash to the stored value. Any input change makes the pair
**unverified**; a status flip never does. States are: **verified / unverified /
refused**.

\`yg check\` is a pure read — it recomputes each pair's hash and reports, executing
nothing and making no LLM calls. \`yg check --approve\` fills every unverified pair
and then reports. These two commands are the only writers of verdicts (with
\`yg log merge-resolve\` writing the lock's per-node log baseline).

## Pairs and units

Verification runs per \`(aspect, unit)\` **pair**. A **unit** is the subject of one
verification, set by the aspect's \`scope\`:

- \`scope.per: node\` (default) — one unit per node: the whole node. One verdict
  over all the node's subject files.
- \`scope.per: file\` — one unit per subject file. One verdict each.

The **subject set** is the node's mapped files (child carve-out applied) narrowed
by \`scope.files\` (absent filter = all mapped files; LLM aspects additionally drop
binary files, which cannot enter a prompt). An empty subject set produces no
pairs on that node — a legitimate vacuous pass, no verdict, no entry.
\`yg context --node\` shows the per-aspect subject-file count so a mis-written
\`scope.files\` is observable.

## Lock format

\`\`\`jsonc
{
  "version": 1,                              // lock FORMAT version
  "verdicts": {
    "<aspectId>": {                          // keys sorted at every level
      "node:billing/cancel":   { "verdict": "approved", "hash": "<inputHash>" },
      "file:src/billing/x.ts":  { "verdict": "refused",  "hash": "<inputHash>",
                                  "reason": "<violation report>" },
      "node:billing/notify":    { "verdict": "approved", "hash": "<inputHash>",
                                  "touched": [["read:src/shared/codes.ts", "<sha256>"],
                                              ["list:src/billing", "<sha256>"]] }
    }
  },
  "nodes": {
    "billing/cancel": {
      "source": "<sha256>",                  // source fingerprint — the log gate's basis
      "log": { "last_entry_datetime": "<ISO>", "prefix_hash": "<sha256>" }
    }
  }
}
\`\`\`

- The unit key is prefixed: \`node:<model-relative path>\` or
  \`file:<repo-relative POSIX path>\`. The entry's aspect determines its reviewer
  kind — entries carry no kind marker.
- \`reason\` is stored only on a \`refused\` entry (the reviewer's violation report,
  or a deterministic check's recorded violations) so plain \`yg check\` renders the
  violation without re-running anything.
- \`touched\` appears only on deterministic entries, recording observations OUTSIDE
  the subject set (see the observation fold below).
- \`nodes.<path>\` carries the source fingerprint (the log gate's contract,
  \`yg knowledge read log-management\`) and the append-only log integrity baseline.
- Serialization is canonical: code-point-sorted keys, stable formatter, trailing
  newline — so git's line merge aligns with entry boundaries.

## inputHash — the frozen contract

The hash folds, for both kinds:

\`\`\`
aspect:  <aspect id>
scope:   <canonical scope; absent normalizes to {per: node, files: none}>
node:    <owning node path>                 // pins per-file units to their context
rule:    sha256(content.md | check.mjs bytes)
files:   [ [path, sha256(bytes)], ... ]     // subject files, sorted
verdict: "approved" | "refused"             // the discrete token — tamper evidence
\`\`\`

LLM pairs additionally fold their prompt inputs: the aspect description, each
reference \`[path, sha256(bytes), description]\`, and the resolved tier
\`{name, provider, consensus, config}\`.

Deterministic pairs additionally fold the **observation set** — everything the
check observed through \`ctx\` beyond its subject files, recorded by the runner:

\`\`\`
read:<path>   → sha256 of the file bytes read
list:<dir>    → sha256 of the sorted entry name+kind list
exists:<path> → sha256 of the returned token ('file' | 'dir' | 'false')
graph:<node>  → sha256 of that node's yg-node.yaml bytes
\`\`\`

Observation-completeness is load-bearing: a deterministic verdict is reusable
only if NO observed value changed — including negative \`exists\` probes and
directory listings (an aspect may enforce file names, so the name list itself is
an input).

### Excluded from the hash, deliberately

- **\`status\`** — \`advisory ↔ enforced ↔ draft\` flips never invalidate a verdict
  (rendering only).
- **\`reason\`** / free-text output — only the discrete verdict token is folded.
- **Node description** — prompt garnish, not hashed (the aspect description IS
  hashed for LLM pairs).
- **\`timeout\`** and **api_key** in tier config — transport / secret knobs, not
  judgment inputs.
- **\`max_prompt_chars\`** — a gate, not an input; lowering it can trip the gate on
  an already-verified pair without invalidating the verdict.
- **\`when\` / \`implies\` / port declarations** — applicability is recomputed live
  each run and acts through the expected-pair set, not through invalidation.
- **CLI version / prompt scaffold** — upgrading Yggdrasil must not invalidate
  verdicts. The flip side is binding: the hash canonicalization is a frozen
  contract, changed only as a deliberate breaking decision.

Validity is checked by recomputing the hash from current inputs plus the stored
verdict token; a mismatch — whether from an input change or a hand-edited verdict
— renders the pair unverified. Tampering degrades to "needs review", never to
green. This is tamper *evidence* against casual edits, not cryptography; the trust
model is reviewing lock diffs in PRs and never hand-editing the lock.

## Caching policy

- **Both verdicts are cached, for both kinds.** A \`refused\` entry for unchanged
  inputs is FINAL — re-running \`yg check --approve\` does NOT re-verify it (for a
  deterministic pair a re-run is pointless; for an LLM pair it would be a
  re-roll). The three exits from a refusal:
  1. **Fix the code** — changes a subject file, invalidates the pair, re-verifies.
  2. **Sharpen the aspect's \`content.md\`** — changes the \`rule\` hash and
     re-verifies EVERY node using the aspect. Run \`yg impact --aspect <id>\` first.
  3. **\`yg-suppress\` with the user's approval** — a documented file-level waiver.

  There is deliberately no force / re-judge / verdict-drop command. Do NOT make a
  cosmetic edit to the aspect text or a source file purely to force an LLM
  re-roll — that is the same laundering the absent command refuses to offer.
- **Verdicts survive status flips**, including a \`draft\` round-trip: an entry for
  unchanged inputs stays valid when the aspect returns to enforced. To park an
  aspect, use \`status: draft\`, never a \`when\` edit — garbage-collection prunes
  when-excluded pairs but keeps draft pairs. Parking and unparking via draft buys
  no fresh look.
- **Fail-closed**: an entry is written only on a real verdict. Every infra
  disposition (provider unreachable, no reviewer configured, reference-load
  failure, unparseable response; for deterministic pairs a \`check.mjs\` import
  failure or thrown error) writes nothing — the pair stays unverified. There is no
  "infra" verdict state.

## Garbage-collection

At the end of a successful \`yg check --approve\` run the lock is rewritten
canonically. Verdict entries whose pair is no longer in the pair universe (aspect
detached or deleted, file deleted or unmapped, \`scope\`/filter change, \`when\` now
false) are pruned, and \`nodes\` entries for node paths that no longer exist are
pruned. The pair universe for GC ignores status — **draft pairs keep their
entries**, which is what makes a draft round-trip free.

## Merge conflict in yg-lock.json

\`verdicts\` entries are self-validating, so resolution is trivial and safe by
construction:

1. Take ONE side wholesale:
   \`git checkout --ours -- .yggdrasil/yg-lock.json\` (or \`--theirs\`). Prefer the
   side covering more of the merged code, to minimize re-verification.
2. Run \`yg check --approve\`. A wrongly kept line cannot lie — its hash will not
   match current inputs, so it re-verifies; the discarded side's verdicts are
   simply re-filled.

Do NOT hand-merge entry-by-entry even though entries are self-validating —
structural damage (duplicate keys, stray conflict markers) turns the whole file
\`lock-invalid\` (fail closed). \`lock-invalid\` detection recognizes \`<<<<<<<\`
conflict markers and points back here.

When BOTH \`log.md\` files and the lock conflicted, the order is: resolve the lock
(take a side) → \`yg log merge-resolve --node <path>\` per conflicted log →
\`yg check --approve\`.

## Reverting a node

There is no per-node state file to check out, and the lock holds EVERY node's
verdicts. To roll a node back, revert its source and \`log.md\` via git and accept
one re-verification at the next \`yg check --approve\` (its pairs invalidate
because the subject files changed). NEVER check out the whole lock to roll back
one node — that clobbers every other node's verdicts. (Full revert recipe:
\`yg knowledge read log-management\`.)

## Absent or garbled lock

An absent file = empty lock (all expected pairs unverified). A garbled or
unparseable file, or an unrecognized \`version\`, is a blocking \`lock-invalid\`
error (fail closed); the \`next:\` covers both recoveries — restore from git, or
delete the file and re-fill via \`yg check --approve\` (which re-verifies
everything).

## See also

- [[aspects-overview]] — reviewer kinds, scope, cost model
- [[aspect-status]] — severity-by-status, verdict reuse across flips
- [[log-management]] — the log gate, positive closure, revert recipe
- [[writing-deterministic-aspects]] — the observation surface
`;
