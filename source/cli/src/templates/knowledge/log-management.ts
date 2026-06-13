export const summary =
  'Log purpose (WHY-first), opt-in gate, positive-closure cycle, source-fingerprint gate, lock as baseline home, format constraints, Supersedes, typo recovery, revert recipe, git-merge resolution, large logs';

export const content = `# Log management

Per-node \`log.md\` captures business reasoning, gotchas, and constraints
that the reviewer does not see but future agents need.

## Purpose — WHY first

The log carries WHY a change was made — the intent behind it. WHAT changed is the
diff and the aspect content; do not duplicate it. The gate exists to force intent
capture where the team decided it matters.

## When a log entry is required — the opt-in gate

\`log_required\` defaults to \`false\` per node type. It is enabled on types whose
changes carry business intent worth capturing (\`yg knowledge read
working-with-architecture\` is the home for that guidance). To know whether a node
needs an entry, check its type in \`yg-architecture.yaml\`, or read the node's log
state line in \`yg context --node\`.

A fresh log entry is required BEFORE \`yg check --approve\` whenever BOTH hold:

- the node's type has \`log_required: true\`, AND
- the node's mapped source changed since its last positive closure (or this is the
  first verification and the node owns source files).

"Fresh" means newer than the entry recorded at that closure — one fresh entry per
closure cycle. The requirement depends ONLY on the type flag and the source
change. It is INDEPENDENT of aspect status. A node with no source change
(cascade-only re-verification — an aspect was edited, the source untouched) needs
no new entry.

## Positive closure — the cycle

Positive closure is the moment a \`yg check --approve\` run ends with every ENFORCED
pair of the node — deterministic and LLM uniformly — approved. At closure the lock
records the node's source fingerprint and the log freshness baseline.

Corollaries:
- Advisory refusals do NOT prevent closure.
- A node with only advisory/deterministic aspects, or no pairs at all, closes
  vacuously.
- A red enforced pair of either kind keeps the cycle OPEN — the same log entry
  stays valid through every retry until the node is actually green. Intent does
  not change between retries; only execution does.

## The source fingerprint and the lock

The gate's "mapped source changed" test is computed from a per-node **source
fingerprint** — one sha256 fold over the sorted \`[path, sha256(bytes)]\` list of
ALL the node's mapped files (the full mapping, not the scope-filtered subject
sets; binaries included by bytes). It lives in \`yg-lock.json\` under
\`nodes.<path>.source\`, written at positive closure. The append-only log integrity
baseline (boundary datetime + prefix hash) lives beside it under
\`nodes.<path>.log\`. There is no separate per-node state file.

The basic workflow:

  1. Edit source files
  2. \`yg log add --node <path> --reason "<justification>"\`
  3. \`yg check --approve\`

If you forget step 2, the gate raises \`log-entry-missing\` and that node's pairs
are skipped (other nodes proceed); add the entry and re-run. If a pair is refused,
iterate on the code WITHOUT adding new log entries — one entry covers all edits
until the node reaches closure.

## Self-contained entry — worked example

The rules for self-contained entries are in agent-rules.md (Log management
section). This example illustrates them in practice.

Avoid:

\`\`\`
Plan Task 3.2. Generate IDs client-side as discussed in the design doc.
Matches the pattern used by the existing order-create handler.
\`\`\`

A reader cannot find the plan, the design doc, or the handler in its
original form. None of the references survive the next iteration.

Prefer:

\`\`\`
Order IDs are generated client-side (UUIDv7) instead of via a database
sequence. UUIDv7 keeps inserts roughly time-ordered for index locality
while removing the round-trip needed to fetch the next sequence value
before publishing the order to downstream services. Collision risk at
expected volume is negligible and accepted in exchange for the simpler
write path.
\`\`\`

Same decision, all rationale embedded in the entry.

## Format constraints (validated by yg check)

- Entry headers \`## [<ISO datetime UTC with milliseconds>]\` are reserved.
- Sub-headings in your \`--reason\` must be level 3+ (\`###\` or deeper).
- Do not put a level-2 heading (\`##\`) at the start of any line in your
  \`--reason\` content. Only a real line-start level-2 heading is the
  problem — a \`## \` that appears inside a fenced code block is allowed.
- Multi-line content via bash \`$'multi\\nline'\` or via \`--reason-file <path>\`.
- Datetimes must be strictly ascending across entries.

## Correcting a previous entry that turned out wrong

Append-only blocks editing historical entries. To supersede an earlier
entry, append a new entry whose body opens with:

\`\`\`
### Supersedes: <prior ISO datetime>
\`\`\`

Future agents reading the log see the structured supersedes and know which
entries no longer hold.

## Recovery from typo in a fresh entry (BEFORE the node reaches closure)

If you just ran \`yg log add\` and notice a typo, and the node has NOT reached
positive closure since (no entry baseline was recorded over the typo):

\`\`\`bash
git checkout .yggdrasil/model/<path>/log.md
yg log add --node <path> --reason "<correct text>"
\`\`\`

The log baseline in the lock is unchanged because no closure happened, so checking
out just \`log.md\` is safe and integrity remains intact. Do NOT use this path once
the node has closed over the typo'd entry — at that point the entry is in the
baseline and you must use the Supersedes convention instead.

## Reverting a change you regret

Do NOT add a "correction" entry to \`log.md\` — that would still leave the wrong
code in place. There is no per-node state file to roll back, and the lock holds
EVERY node's verdicts — so NEVER check out the whole lock to revert one node;
that would clobber every other node's verdicts. Revert source and log via git:

\`\`\`bash
git checkout HEAD~1 -- \\
  src/file.ts \\
  .yggdrasil/model/<path>/log.md
yg log add --node <path> --reason "Tried X, reverted because Y"
yg check --approve
\`\`\`

The reverted source files change the node's subject hashes, so its pairs
invalidate and \`yg check --approve\` re-verifies just this node — accept that one
re-verification. The new log entry records the revert; closure re-establishes the
node's baseline.

## After a git merge

If both branches added log entries to the same node, run from the merge
commit:

\`\`\`bash
yg log merge-resolve --node <path>
\`\`\`

The tool validates byte-exact ancestor portion and union of new entries — it
cannot silently drop or fabricate entries — and writes the reconciled history plus
the node's \`log\` baseline into the lock. Do NOT manually concatenate the two log
histories — integrity hashes will break and \`yg check\` will fail.

When BOTH \`log.md\` and \`yg-lock.json\` conflicted, the order is: resolve the lock
(take ONE side wholesale) → \`yg log merge-resolve --node <path>\` per conflicted
log → \`yg check --approve\`. (Lock merge mechanics:
\`yg knowledge read verification-and-lock\`.)

## Never edit log.md directly

Integrity verification catches any modification of historical entries (entries
before the last closure). Edit only via \`yg log add\`. The exceptions above (typo
recovery, revert) operate on the file but via git, not by hand-editing.

## Large logs

When \`log.md\` is large (rough threshold: >50 entries OR >5000 tokens),
do not load full content into your context. Delegate to a subagent:

\`\`\`
Read .yggdrasil/model/<path>/log.md, summarize relevant context for
task: <task description>. Return key decisions, constraints, and
gotchas only.
\`\`\`

Use the returned summary, not the full log.

## Log add does not verify

\`yg log add\` does NOT invalidate any verdict or run the reviewer. You can append
context entries between code changes freely. Only source-file changes in the
mapping require entries paired with \`yg check --approve\`.
`;
