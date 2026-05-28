## [2026-05-15T08:46:12.622Z]
Add --type <id> mode: shows type metadata (description, enforce, when, aspects), nodes of that type with count, source files covered (up to 20), and strict coverage gap (orphans + misplaced) when enforce=strict. Mutex with --node/--file/--aspect/--flow.
## [2026-05-15T09:57:38.623Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T12:12:58.897Z]
R0.3: updated import from utils/repo-scan to io/repo-scanner (no logic change)
## [2026-05-15T12:28:17.897Z]
R0.4: file-content-cache import updated from core to io (no logic change)
## [2026-05-15T20:45:36.280Z]
Add debugWrite() to catch block — required by diagnostic-logging aspect to surface errors via debug channel.
## [2026-05-16T03:57:21.039Z]
Fix: stdout (not stderr) for --file resolution success message; add debugWrite() already present in catch block.
## [2026-05-16T04:42:33.168Z]
Revert file->node resolution to stderr — test suite explicitly expects this diagnostic output on stderr (not stdout). The previous change was incorrect.
## [2026-05-16T05:57:55.222Z]
Phase 4.7 (no-direct-fs): inject appendToDebugLog as third argument to initDebugLog; debug-log DI refactor decouples utils/debug-log from node:fs
## [2026-05-16T08:39:07.117Z]
Use buildIssueMessage for all 5 not-found/no-coverage errors: satisfies what-why-next aspect added via graph-analysis flow
## [2026-05-16T17:37:13.929Z]
Replaced inline 'No .yggdrasil/ directory found' error block with the shared loadGraphOrAbort helper from formatters/cli-preamble.ts. Reason: the same string and exit-1 logic was duplicated across 12 CLI command handlers; centralization eliminates a copy-paste class and routes the missing-graph message through buildIssueMessage uniformly. Other errors continue to flow through the surrounding catch and will be migrated to buildIssueMessage in the next task.
## [2026-05-16T18:22:20.678Z]
Migrated remaining ad-hoc stderr errors to buildIssueMessage (constant-text errors wrapped inline) and routed generic catch-blocks through the new abortOnUnexpectedError helper from formatters/cli-preamble.ts. Reason: even after the loadGraphOrAbort centralization, command-specific errors and option-validation messages bypassed the what/why/next structure; this commit aligns them so the AST aspect added in the next commit can enforce the rule mechanically.
## [2026-05-16T18:54:56.519Z]
Wrapped three option-validation errors (--node/--file mutex, missing target, multiple targets) in buildIssueMessage. Matches the cli-command-contract requirement that constant-text remediation errors use the structured what/why/next form.
## [2026-05-16T19:31:39.274Z]
Updated effective-aspects import path to core/graph/aspects.
## [2026-05-28T10:05:15.685Z]
Extended handleFileImpact to scan all graph nodes for cascade-via-reference when the queried file appears in a node's collectTrackedFiles result with category 'graph' and layer 'aspects'. When the structural owner exists, both sections are shown. When no owner exists but reference-cascade nodes do, the reference section is shown and the command exits 0 instead of failing. When both sets are empty, the existing no-coverage error is emitted. This enables agents to assess the full blast radius of a file that functions as an aspect reference — the same file could cascade drift to multiple nodes even if it has no mapping owner.
## [2026-05-28T14:01:40.557Z]
Surface effective per-(node, aspect) status in yg impact. For --aspect runs each directly affected node line ends with [<status>] showing how the aspect resolves on that node (cascade may bump above the aspect default). For --node runs the Aspects: summary annotates each aspect with its effective status, and Nodes sharing aspects shows the status as seen on the other node. The current command has no status-simulation flag, so the flip-risk note for advisory-to-enforced swaps was deliberately deferred — it can land alongside a future --simulate-status option.
## [2026-05-28T19:39:36.743Z]
Add rendering-severity-flip annotation per design §12.1. When yg impact --aspect lists affected nodes, also read each node's drift-state baseline and call out nodes whose aspectVerdicts[X] is refused. If the user later flips the aspect's status (advisory ↔ enforced), those refused baselines will flip how yg check renders them; surfacing this proactively in impact output gives the agent the information before the status change, not after.
## [2026-05-28T19:41:42.888Z]
Pre-existing fix surfaced during dogfood review: change line 532 from process.stderr.write to process.stdout.write for the file->nodePath resolution message. This is informational output, not an error, so it belongs on stdout per the command-error-via-buildissuemessage aspect's contract that 'errors go exclusively to stderr and all results go to stdout'. Bundled with the rendering-flip annotation change because the reviewer caught it in the same commit boundary.
