export const summary = 'Log format constraints, Supersedes convention, typo recovery, revert with drift state, git-merge resolution, large-log delegation';

export const content = `# Log management

Per-node \`log.md\` captures business reasoning, gotchas, and constraints
that the reviewer does not see but future agents need. Every source edit in
a node's mapping requires a log entry before \`yg approve\` (for nodes whose
type has \`log_required: true\`, the default).

The basic workflow (edit → log add → approve) is in agent-rules.md. This
file covers everything else: format constraints, recovery, revert, merging,
large-log handling.

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

Same decision, all rationale embedded in the entry. A reader years from
now still understands what was decided and why, regardless of what
happened to the plan or the code.

## Format constraints (validated by yg check)

- Entry headers \`## [<ISO datetime UTC with milliseconds>]\` are reserved.
- Sub-headings in your \`--reason\` must be level 3+ (\`###\` or deeper).
- Do not put a level-2 heading (\`##\`) at the start of any line in your
  \`--reason\` content — UNLESS inside a fenced code block, those are allowed.
- Multi-line content via bash \`$'multi\\nline'\` or via \`--reason-file <path>\`
  (the file-based form is cross-platform; it reads the entire file as the
  entry body).
- Datetimes must be strictly ascending across entries.

## Correcting a previous entry that turned out wrong

Append-only blocks editing historical entries. To supersede an earlier
entry, append a new entry whose body opens with:

\`\`\`
### Supersedes: <prior ISO datetime>
\`\`\`

Future agents reading the log see the structured supersedes and know which
entries no longer hold.

## Recovery from typo in a fresh entry (BEFORE first approve)

If you just ran \`yg log add\` and notice a typo in \`--reason\`, and no
approve has run since (the drift-state baseline still points to the previous
state):

\`\`\`bash
git checkout .yggdrasil/model/<path>/log.md
yg log add --node <path> --reason "<correct text>"
\`\`\`

The drift-state baseline is unchanged because no approve happened, so
checking out just \`log.md\` is safe and integrity remains intact. Do NOT
use this path if approve has already run on the typo'd entry — at that
point the entry is in the baseline and you must use the Supersedes
convention instead.

## Reverting a change you regret

Do NOT add a "correction" entry to \`log.md\` — that would still leave the
wrong code in place. Use git to revert source, log, AND drift state
together:

\`\`\`bash
git checkout HEAD~1 -- \\
  src/file.ts \\
  .yggdrasil/model/<path>/log.md \\
  .yggdrasil/.drift-state/<path>.json
yg log add --node <path> --reason "Tried X, reverted because Y"
yg approve --node <path>
\`\`\`

All three files move together. Then a new log entry records the revert
itself, and approve re-establishes the baseline.

## After a git merge

If both branches added log entries to the same node, run from the merge
commit:

\`\`\`bash
yg log merge-resolve --node <path>
\`\`\`

The tool validates byte-exact ancestor portion and union of new entries —
it cannot silently drop or fabricate entries.

Do NOT manually concatenate the two log histories — integrity hashes will
break and \`yg check\` will fail.

## Never edit log.md directly

Integrity verification catches any modification of historical entries
(entries before the last approve). Edit only via \`yg log add\`. The
exceptions above (typo recovery, revert) operate on the file but via git,
not by hand-editing.

## Large logs

When \`log.md\` is large (rough threshold: >50 entries OR >5000 tokens),
do not load full content into your context. Delegate to a subagent:

\`\`\`
Read .yggdrasil/model/<path>/log.md, summarize relevant context for
task: <task description>. Return key decisions, constraints, and
gotchas only.
\`\`\`

Use the returned summary, not the full log.

## Drift independence

\`yg log add\` does NOT trigger drift or run the reviewer. You can append
context entries between code changes freely. Only source-file changes in
the mapping require entries paired with \`yg approve\`.

## Log requirement and aspect status

Every source edit in a node's mapping requires a log entry before \`yg approve\`
(for nodes whose type has \`log_required: true\`, the default). However, when
a node's EVERY effective aspect is in draft status, a log entry is not
required — draft aspects are dormant and will not be reviewed. See:
\`yg knowledge read aspect-status\`.
`;
