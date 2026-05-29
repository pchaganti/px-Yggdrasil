# What-Why-Next Messaging

Every diagnostic or error message that agents consume must follow the what/why/next structure. How this is expressed depends on the layer:

- **CLI command modules** (`cli/commands/`, `cli/cli/`): all agent-visible output must derive from structured `IssueMessage` data (`{ what, why, next }`). The standard path is to call `buildIssueMessage({ what, why, next })` when writing to `process.stderr.write` or constructing visible output strings. A CLI renderer that accesses `issue.messageData.what`, `issue.messageData.why`, and `issue.messageData.next` individually to render them with labels (e.g. `Why: ...` / `Fix: ...`) also satisfies this rule — what matters is that the output is derived from structured messageData, not hardcoded strings.
- **Engine modules** (`core/`, `ast/`, `io/`): return structured `messageData: IssueMessage` with `{ what, why, next }` fields populated. The CLI command layer calls `buildIssueMessage()` on them for presentation. Engine modules do NOT call `buildIssueMessage` — they are not the formatting layer.

## Rules

- Every agent-visible diagnostic (validation errors, drift reports, approval failures, context build failures) must have `what`, `why`, and `next` populated.
- The `next` field must contain a concrete runnable command or actionable instruction.
- Ad-hoc `Error: ${msg}` strings are acceptable ONLY for fatal/unexpected errors (I/O failures, missing arguments) where there is no remediation path beyond "fix the environment."
- The standardized ENOENT-from-loadGraph message `Error: No .yggdrasil/ directory found. Run 'yg init' first.` is exempt — this exact string is required by the `cli-command-contract` aspect and takes precedence.
- If a message guides agent remediation (telling the agent what to do next), it MUST use the structured format.
- Engine modules satisfy this aspect by populating `messageData: IssueMessage` on returned result objects — not by calling `buildIssueMessage`. The CLI command handler is where rendering happens.
- `throw new Error(msg)` in engine modules is exempt — throws are internal signals caught by the CLI command handler, which is responsible for formatting the output. The exception message does not need what/why/next structure.
- `AspectResponse.reason` and `AspectViolation.reason` fields are reviewer assessment outputs — they carry the LLM's evaluation of why code satisfies or violates an aspect. These are not CLI diagnostic messages; they flow from the LLM back into the baseline store and are rendered as part of structured `CheckIssue.messageData` by the CLI layer. They are explicitly exempt from the what/why/next requirement.
