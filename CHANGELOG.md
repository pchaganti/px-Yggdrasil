# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `yg structure-test` command — mirrors `yg ast-test` for structure aspects (`reviewer.type: structure`). Runs `check.mjs` against a named graph node without recording a baseline, enabling iterative development of structure aspects. `--check-determinism` flag runs the check twice and exits 1 if violation sets differ (lexically sorted), detecting side effects in `check.mjs` before they cause flaky CI. Graph-level violations (no `file`) are rendered as `<graph>: <message>`; file violations are grouped by path and sorted by line. Architecture updated to allow `command` nodes to call `structure-adapter` (parallel to the existing `ast-adapter` allowance for `yg ast-test`).
- Agent rules: added a "Past entries are not a template" paragraph to the "Log management — workflow" section of `source/cli/src/templates/rules.ts`. The paragraph names log-entry mimicry as a failure vector and tells the agent not to copy the surface style of prior log entries that reference plans, tasks, phase numbers, section markers, or file paths in their bodies, even when surfaced via `yg log read`. Complements the existing self-containment rule with a behavior override at the decision point where in-context priming from contaminated historical entries previously dominated. Regenerated `.yggdrasil/agent-rules.md` via `yg init --upgrade --platform claude-code`.
- `yg context --file` and `yg context --node` now render the effective aspect status next to each aspect id as `<id> [<status>]`. When the resolved status is `draft`, the formatter emits a `(reviewer skipped; aspect is draft)` notice in place of the aspect's `read:` lines (both the aspect content path and any reference paths), since draft aspects do not reach the reviewer. Enforced and advisory aspects retain the full `read:` list. Aspects without an explicit status default to `enforced` in the rendered tag.
- `yg impact`, `yg aspects`, `yg find`, and `yg context` now surface aspect enforcement status (draft / advisory / enforced) inline. `yg aspects` renders `[<status>]` next to each aspect id from the aspect-default. `yg find` adds a `status: <enum>` line for aspect-kind results. `yg impact --aspect` annotates each directly affected node with its effective status on that node, and `yg impact --node` includes the effective status next to each aspect on the `Aspects:` summary and `Nodes sharing aspects` listing. `buildNodeContextData` and `buildFileContextData` populate a new optional `status` field of type `AspectStatus` on every aspect entry so downstream formatters can render it without recomputing. `IndexedDocument` gains an optional `status` field (populated for aspect kind only) and stores it in MiniSearch `storeFields`.
- `clearDraftAspectsFromDriftState(yggRoot, nodePath, aspectIdsToClear)` in `io/drift-state-store.ts` — removes specified aspect IDs from the per-node baseline's `aspectVerdicts` map. `approve-reviewer.ts` wraps every `commitApproval` call in a `commitApprovalAndCleanDrafts` helper that collects effective-draft aspects for the node and evicts their stored verdicts after commit, so verdicts recorded under a prior approve do not linger in the baseline after an aspect transitions to `draft` (dormant) status. No-op when the node has no stored state, no `aspectVerdicts` field, or no overlap with the requested IDs; the field is dropped entirely when removal empties the map.
- `DriftNodeState.aspectVerdicts: Record<string, AspectVerdict>` — per-aspect verdict captured at approve time. `AspectVerdict` carries `verdict: 'approved' | 'refused'` plus, for refused entries, the `reason` and `errorSource` (`codeViolation` | `provider` | `astRuntime`). Verdicts are recorded for every non-draft effective aspect that the reviewer evaluated. `approve-reviewer.ts` now writes the baseline EVEN on refused branches so downstream commands can render per-aspect refused state from the stored baseline without re-running the reviewer. In a filtered approve (`--aspect <id>`), prior verdicts for untouched aspects are preserved by merging new verdicts on top of the stored baseline's verdicts; in an unfiltered approve, the new verdicts fully replace the prior set.
- `yg check` now renders findings by aspect status. New issue codes: `aspect-newly-active` (error — a non-draft effective aspect has no baseline verdict on a node; emitted on status flip, new attach, or fresh aspect), `aspect-violation-enforced` (error — refused baseline + enforced status), `aspect-violation-advisory` (warning — refused baseline + advisory status). Per-node short-circuit now uses `hasNonDraftEffectiveAspects` so nodes whose every effective aspect resolves to draft skip drift detection entirely; the drift-state GC predicate uses the same helper so dormant baselines are reaped on the next check. Legacy baselines (written before `aspectVerdicts` existed) are tolerated as "implicitly approved" so the 5.x upgrade does not flood the user with `aspect-newly-active`. `CheckResult` adds `advisoryWarnings` and `draftSkipped` tallies surfaced as a footer block under the result line. `suggestedNext` prefers an error's `next` field over a warning's, so an enforced violation outranks a co-emitted advisory.
- Validator: `aspect-status-downgrade` detects when an explicit attach-site declares an aspect status lower than the cascading anchor (max of other channels, falling back to the aspect default). Covers all six explicit channels — own, ancestor node, own arch type, ancestor arch type, flow, port. Cascaded defaults remain anchors and are never flagged themselves; only explicit overrides that would silently weaken enforcement are surfaced as errors via `aspectStatusDowngradeMessage`.
- Aspect reference files: LLM aspects may declare `references:` in `yg-aspect.yaml` to provide supporting context (lookup tables, catalogues) to the reviewer prompt and to the agent under `read:`. Includes per-tier size limits (`references.max_bytes_per_file`, `references.max_total_bytes_per_aspect`) in `yg-config.yaml`, drift cascade on reference file edits, and validator rules `aspect-reference-broken`, `aspect-reference-too-large`, `aspect-reference-escape`, `aspect-reference-duplicate`, `aspect-references-on-ast`, `aspect-reference-invalid-form`, `aspect-reference-blank-path`, `aspect-references-empty-array`.
- `parseAspect` now returns `ParseAspectResult` (discriminated union `{ ok: true; aspect }` | `{ ok: false; aspectId; errors }`) instead of throwing on invalid reviewer shapes. Structured error codes: `aspect-reviewer-missing`, `aspect-reviewer-legacy-string`, `aspect-reviewer-not-mapping`, `aspect-reviewer-type-missing`, `aspect-reviewer-type-invalid`, `aspect-ast-tier-not-allowed`, `aspect-reviewer-unknown-key`, `aspect-reviewer-tier-invalid`. Legacy string form (`reviewer: llm`) is no longer silently accepted — it returns `aspect-reviewer-legacy-string`.
- `graph-loader.ts`: `loadAspects` propagates `ParseAspectResult` failures into `Graph.aspectParseErrors` instead of silently dropping them. Aspects that fail to parse are excluded from `graph.aspects`.
- New engine node `cli/core/reviewer-tiers` with three source files: `tier-identity.ts` (canonical JSON for LLM tier drift detection), `tier-selection.ts` (aspect-to-tier resolution supporting explicit and default tier), `format-version.ts` (v4/v5 config and aspect YAML shape detection predicates).
- New test-suite node `cli/tests/unit/core/reviewer-tiers` with unit tests for tier-identity, tier-selection, and format-version.
- AST aspect yaml: required field `language: [<id>, ...]` for `reviewer: ast`. Four new structural-check errors enforce the field shape: `aspect-ast-missing-language`, `aspect-language-not-array`, `aspect-empty-language-list`, `aspect-unknown-language`.
- Language registry stub in `source/cli/src/core/graph/language-registry.ts` — phase 1 covers typescript/tsx/javascript; phase 3 expands to 35.
- `findComments(target)` exported from `@chrisdudek/yg/ast` — returns comment nodes for a file or subtree, reads comment node types from language registry per `ctx.language`.
- Runtime error `AST_CHECK_FILE_NOT_IN_CONTEXT` — aspect returns violation for a file not in ctx.files.
- AST aspect `read-or-default-via-helper` — applied to `persistence-adapter` and `parser-adapter` node types. Forbids inline ENOENT-swallow around `readFile` in IO files; future code must use `readFileOrDefault`. Compound try blocks (e.g. `lstat` + `readFile`) and non-readFile fs operations are correctly skipped.
- AST aspect `parser-yaml-guard` — applied to `parser-adapter`. Requires every YAML parser to include `Array.isArray(raw)` in the top-level shape guard. Fixes a latent bug where a YAML array document silently passed the existing `typeof raw === 'object'` check (since arrays are typeof `'object'`) and failed later at the first property access. `flow-parser`, `node-parser`, and `aspect-parser` had their guards extended; `schema-parser` and `architecture-parser` already conformed.
- New helper `formatters/cli-preamble.ts` with `loadGraphOrAbort`. Twelve CLI commands (all except `init`, which bootstraps the graph) now delegate the "No .yggdrasil/ directory found" error to this single helper instead of inlining the string and ENOENT branch themselves. The helper emits a structured what/why/next message via `buildIssueMessage` and exits 1 on ENOENT-shaped loader failures; non-ENOENT errors continue to flow through the surrounding catch in each command. The `cli-command-contract` aspect's `content.md` was updated to reference the new helper as the canonical graph-loading entry point.
- New helper `abortOnUnexpectedError` in `formatters/cli-preamble.ts`. All command catch-blocks (`approve`, `aspects`, `ast-test`, `build-context`, `check`, `find`, `flows`, `impact`, `init`, `knowledge`, `log`, `owner`, `tree`, `type-suggest`) route generic errors through this single emit point, producing a uniform "Unexpected error while <context>: <msg>" wrapped in `buildIssueMessage`. Constant-text command errors (option mutex violations, "node not found", "unknown topic", "unknown platform", `init --upgrade` missing-graph) wrap inline `buildIssueMessage`. All command-side stderr errors now route through `buildIssueMessage` directly or via the helpers.
- AST aspect `command-error-via-buildissuemessage` — applied to `command` node type. Forbids raw `process.stderr.write` of error-shaped strings (chalk.red, `Error:`, `ERROR:`) in command handlers unless the surrounding code routes the message through `buildIssueMessage`, `loadGraphOrAbort`, or `abortOnUnexpectedError`. Prevents regression to the inline error-string pattern that the prior commits eliminated.
- New `cli/core/graph` engine node and `source/cli/src/core/graph/` directory housing pure graph-query helpers: `traversal.ts` (`collectAncestors`, `collectDescendants`), `flows.ts` (`collectParticipatingFlows`), `dependencies.ts` (`collectDependencyAncestors` + `DependencyAncestorInfo`), and `index.ts` barrel. `context-builder.ts` keeps a re-export shim for legacy importers; `when-evaluator.ts` drops its private `collectDescendants` duplicate. Establishes the canonical home for future graph queries — subsequent tasks move `effective-aspects` and `context-files` into the same directory.
- `core/effective-aspects.ts` moved to `core/graph/aspects.ts`. Exports `computeEffectiveAspects` and `getAspectSource` through the same module path via the `core/graph/index.ts` barrel. Eight importers (engines `approve`, `validator`, `check`, `context-builder`, `context-files`; commands `aspects`, `impact`) plus test files updated to the new path. `cli/core/validator` node mapping drops `effective-aspects.ts`; `cli/core/graph` node mapping adds `aspects.ts`.
- `core/context-files.ts` moved to `core/graph/files.ts`. Exports `collectTrackedFiles` and `TrackedFile` through the same barrel. Seven importers (engines `approve`, `approve-reviewer`, `check`; commands `approve`; `io/hash`) plus test files updated. `cli/core/context` node mapping drops `context-files.ts`; `cli/core/graph` claims it. The `core/graph/` directory now houses the complete graph-query surface; the AST aspect added in the next commit locks the location.
- AST aspect `single-source-graph-queries` — applied to `engine` node type. Forbids redefinition of any of the seven reserved graph-query helpers (`collectAncestors`, `collectDescendants`, `collectParticipatingFlows`, `collectDependencyAncestors`, `computeEffectiveAspects`, `getAspectSource`, `collectTrackedFiles`) outside `source/cli/src/core/graph/`. Catches both `function` declarations and `const = arrow/function` forms. Closes out the four-task migration that established `core/graph/` as the canonical home for graph queries.
- README: new "Companion skills" section between "Works on any codebase" and "Rules can be anything enforceable" — links to LiaisonSkill, BePreciseSkill, and ResearcherSkill. Three smaller skills addressing adjacent disciplines for AI coding agents (intent capture, spec discipline, autonomous experimentation), each installable as a Claude Code plugin or droppable into any markdown-skill agent.
- Structure aspect (`reviewer.type: structure`) — third reviewer type alongside `llm` and `ast`. Enables programmable structural rules via `check.mjs` with a graph-aware `ctx` (own files, fs, graph, parsers). Integrates with aspect-status v5, drift cascade, suppress, and 7-channel propagation. Constrained graph/fs reads (D9=A) — graph stays source-of-truth for dependencies. Trust model (D1=C) — main-thread execution, no sandbox.
- `yg knowledge read writing-structure-aspects` topic.
- First dogfood structure aspect `sibling-test-file` — every CLI command source has a sibling unit test under `cli/tests/unit/cli/`.
- **Reviewer tiers** — `yg-config.yaml` now uses `reviewer.tiers.<name>` (named tier blocks). Each tier declares `provider`, `consensus`, and `config`. Aspects target a tier via `reviewer: { type: llm, tier: <name> }`; aspects without `tier:` use `reviewer.default` (required when more than one tier is configured; optional with exactly one tier). Supported providers: `ollama`, `anthropic`, `openai`, `google`, `openai-compatible`, `claude-code`, `codex`, `gemini-cli`.
- `resolveExecutionPlan` in `approve-reviewer.ts` — groups effective aspects into `{ kind: 'ast' }` or `{ kind: 'llm', tier, tierName }` entries using `selectTierForAspect`. Tier resolution errors produce structured `IssueMessage` failures that abort `yg approve` before any LLM call.
- `runApproveWithReviewer` now executes AST aspects first (no LLM call), grouped and run locally. LLM aspects follow, batched per tier name — one provider instance and one `verifyAspects` call per tier. Infrastructure errors (provider/auth) are distinguished from code violations in the refusal reason.
- Migration `to-5.0.0`: `transformConfigReviewer` converts the legacy flat-provider reviewer block to `reviewer.tiers` — one tier per legacy provider key, named after the provider; `reviewer.active` is renamed to `reviewer.default` (omitted when only one tier results). `transformAspectReviewer` converts `reviewer: <string>` to `reviewer: { type: ... }`. The migration follows a **collect-all policy**: walk every aspect, transform what is unambiguous, leave unrecognized values untouched, and emit a structured warning per problem file. When ANY warning is emitted, `MigrationResult.bumpVersion` is `false` and the runner withholds the version bump — fix the listed files and re-run `yg init --upgrade`. `migrateSecretsFile` is inspect-only: a non-credential field under `yg-secrets.yaml` (anything other than `api_key`) emits a warning and withholds the bump. Multi-provider configs without `reviewer.active` STOP migration before aspects are touched, preserving a recoverable state.
- Migration `to-5.0.0` adds an inspect-only `addAspectStatusDefaults` pass (lives in `source/cli/src/migrations/aspect-status-defaults.ts`, called at the end of `migrateTo50`) that surfaces v5 status-default surprises without rewriting source files. Two warnings are emitted: `aspect-status-migration-escalation` — an aspect whose default is `enforced` implies another aspect with a lower default (`advisory` or `draft`) via a bare string or `{id: B}` without `status_inherit`; under v5's `strictest` propagation the implied aspect will silently promote to `enforced` when reached via the implier. `aspect-status-migration-downgrade` — an explicit per-attach-site `status:` is strictly below the cascading anchor (max of aspect-default and all other channels contributing the same aspect onto the same node). Either warning withholds the version bump; the migrator runner already gates `bumpVersion` on `warnings.length === 0`. The pass parses each YAML directly so it remains robust to pre-v5 parse rules and never invokes the graph layer.
- `yg init` now writes v5 `reviewer.tiers` shape when configuring a new reviewer. Default config version set to `5.0.0`.
- Knowledge topic `configuration` updated with v5 `reviewer.tiers` reference, multi-tier example, and secrets format.
- Docs `configuration.md` and `reviewers.md` updated for v5: tiers reference, correct `yg-aspect.yaml` `reviewer:` object syntax, and consensus-per-tier examples.
- Docs: new `aspect-status.md` deep-reference for adopters — three-level lifecycle (`draft`/`advisory`/`enforced`), declaration sites across channels, max() rule, implies propagation with `status_inherit` (`strictest` default vs `own-default`), drift mechanics, migration from 4.x. Wired into VitePress sidebar. `core-concepts.md` gains an "Aspect status" subsection under Aspects. `reviewers.md` notes that effective-draft aspects are skipped before reviewer dispatch. `cli-reference.md` adds the aspect-status issue codes (`aspect-status-invalid`, `aspect-status-downgrade`, `implies-status-inherit-invalid`, `aspect-newly-active`, `aspect-violation-enforced`, `aspect-violation-advisory`) and a `yg approve` draft-skip note. `conditional-aspects.md` gains a `when` vs. `status` callout. `getting-started.md` recommends starting new aspects at `status: advisory`. `index.md` gains a four-feature highlight on the three-level lifecycle. `showcase.md` adds a `status:` feature section with strictest-vs-own-default examples.

### Changed

- `command` node type gains permission to depend on the new `test-suite` organizational type. Required for the new `sibling-test-file` aspect's cross-node lookup.
- New `structure-adapter` node type added (mirrors `ast-adapter`) covering `source/cli/src/structure/*.ts`.
- New `test-suite` organizational node type added — labels the test directory tree explicitly so commands can declare `uses: <test-suite>` without granting them dependency on every internal module.
- `yg check` output redesigned for agent-friendly terseness: the verbose multi-line header (with per-type node breakdown) is replaced by a single-line verdict + metrics header (`yg check: PASS/FAIL  N nodes · X/Y files · M aspects · K flows · D draft`). Cascade-drift errors with a shared upstream cause are grouped into one block with a `cascade (N)` label and a `→ {node list}` line instead of repeating 8-line what/why/next per affected node. The `Result: PASS/FAIL (0 errors, 0 warnings)` footer is eliminated — verdict is in the header. The `N draft aspects (skipped)` footer tally is absorbed into the header as `· D draft`. The `Next:` line is now a single actionable command (first line of `suggestedNext`, without annotation). `draftSkipped` now counts UNIQUE draft aspect IDs (not node×aspect pairs). `advisoryWarnings` footer tally removed.
- `AspectDef.reviewer` changed from optional `'ast' | 'llm' | undefined` to required `AspectReviewerSpec` (`{ type: 'llm' | 'ast'; tier?: string }`). All comparison sites updated from string equality to `.type` property access.
- `YggConfig.llm: LlmConfig | undefined` renamed to `YggConfig.reviewer: ReviewerConfig | undefined`. `ReviewerConfig` holds `{ tiers: Record<string, LlmConfig>; default?: string }` for named-tier support. `config-parser.ts` wraps the parsed `LlmConfig` in a bridge `tiers` map for v5 compatibility.
- `context-builder.ts`: all graph-derived paths written to output structures (`buildHierarchyLayer`, `buildStructuralRelationLayer`, `buildEventRelationLayer`, `buildNodeContextData`, `buildFileContextData`) now apply POSIX normalization via a shared `normPath` helper. Previously only caller-supplied `nodePath`, `filePath`, and `ownerPath` were normalized at the input boundary.
- `@chrisdudek/yg/ast` API surface reduced to raw tree-sitter primitives: `{ walk, report, inFile, findComments, closest }`. `walk(node, visitor)` replaces `within(parent, type, opts)`; visitor returning `false` skips descent. `closest(node, types)` retained as minimal-API ancestor lookup.
- `inFile` signature changed from string-with-heuristic to discriminated object `{ glob | regex | contains }`.
- `report(file, node, message)` now includes `column` field (0-based from `node.startPosition.column`).
- `AspectViolation.providerError: boolean` and `AspectResponse.providerError: boolean` refactored to required `errorSource: 'codeViolation' | 'provider' | 'astRuntime'`. AST runtime exceptions now flow through `errorSource: 'astRuntime'`.
- All 14 AST aspects rewritten against raw tree-sitter API: `atomic-write-contract`, `command-contract-shape`, `command-error-via-buildissuemessage`, `command-exit-codes`, `migration-bumps-version`, `no-direct-console`, `no-direct-fs`, `no-nondeterminism-direct`, `no-side-effects-on-import`, `parser-yaml-guard`, `posix-paths-source`, `provider-redaction`, `read-or-default-via-helper`, `single-source-graph-queries`.
- README "What Yggdrasil does" section reframed from "reviewer catches what the agent skipped" to "graph is the architecture spec, agent reads relevant aspects before editing, reviewer verifies after". Adds the pre-edit `yg context` step to the loop diagram, surfaces nodes/aspects/flows/ports vocabulary up front, and adds a paragraph on `log.md` as cross-session memory.
- Deduplicated `collectAncestors` in `core/effective-aspects.ts` — removed the leaf-first duplicate; the file now imports the canonical root-first implementation from `core/context-builder.ts`. Removes a bug-in-waiting where future callers could silently reverse traversal order by importing the wrong helper.
- Extracted shared `parsePredicateBoolean` helper into `core/parsing/predicate-boolean.ts`. Both `when-parser` and `file-when-parser` now delegate the `all_of`/`any_of`/`not` parsing to it — eliminates ~50 LOC of identical logic. The helper accepts an optional error class so `file-when-parser` preserves its `WhenPredicateInvalidError` contract.
- Added `io/read-or-default.ts` — small helper that wraps `readFile` with ENOENT-only handling (returns the supplied default on missing file, rethrows other errors). `log-store.readLogSafe` migrated to use it. Persistence-adapter type's `when` predicate extended to claim the new file.
- **BREAKING:** `yg-config.yaml` reviewer format. The legacy single-section shape (provider keys directly under `reviewer:` + `reviewer.active`) is no longer accepted at parse time — the parser raises `config-reviewer-legacy-format` with a migration hint. Use named tiers under `reviewer.tiers` instead. Run `yg init --upgrade` to migrate.
- **BREAKING:** `yg-aspect.yaml` reviewer field. The string shorthand (`reviewer: llm` / `reviewer: ast`) is rejected with `aspect-reviewer-legacy-string`. Required format: `reviewer: { type: llm | ast }` with optional `tier:` (LLM aspects only).
- **BREAKING:** the per-node canonical drift hash now includes a `tier-identity:<aspectId>` synthetic entry per LLM aspect. After running the v5 migration on a previously approved repository, every previously-approved node enters drift on the first `yg check`. Re-approve once per node, or use batch `yg approve --aspect <id>` to fold the bulk re-approve into the upgrade PR.
- `DEFAULT_CONFIG` template version bumped to `5.0.0`.

### Removed

- `@chrisdudek/yg/ast` helpers: `call`, `imports`, `exports`, `decoratorsOf`, `modifiersOf`, `jsxElements`, `casing`, `nameOf`, `within`. Replaced by direct tree-sitter API access via `walk(node, visitor)`. `closest` retained in minimal API.
- Old `inFile(file, string)` signature. Replaced by discriminated object.
- Graph nodes `cli/ast/helpers-syntactic` and `cli/ast/helpers-naming`.
- README: "Too heavy? Try AutoReview" sibling-tool section and the Yggdrasil/AutoReview comparison table. AutoReview is being deprecated and cross-links are being cut across the family.

### Deferred

- Per-invocation result cache for diamond-converging structure aspects — defer until repo-scale dogfood demonstrates redundancy.

### Known limitations

- Two structure aspects on the same node with contradictory rules (e.g. "file X must exist" vs "file X must not exist") are not detected automatically — both refuse forever and the user must read both `check.mjs` files to diagnose. v6.1 will surface a `potential aspect conflict on <file>` meta-warning.

## [4.3.0] - 2026-05-16

### Added

- `yg log add --node <path> --reason <text>|--reason-file <path>` — append-only per-node business log. Each entry is timestamped (ISO 8601 UTC, milliseconds, strict monotonic).
- `yg log read --node <path> [--top N | --all]` — print entries newest-first; default `--top 10`.
- `yg log merge-resolve --node <path>` — reconcile log.md after a git merge (HEAD must be merge commit). Validates byte-exact ancestor prefix and union of new entries.
- `log_required: boolean` field on architecture node types (default `true` when absent). Existing repos migrate to explicit `false` per type via migration `to-4.3.0` for graceful adoption.
- Append-only integrity check (sha256 over baseline prefix) and CommonMark backtick-fence-aware format validator. Both surface as drift in `yg check` and block `yg approve`.
- Logical nodes (no `mapping:`) now support `yg approve` for log-only baseline updates.
- AST aspect reviewer (`reviewer: ast` in `yg-aspect.yaml` + `check.mjs` file).
  LLM reviewer remains the default. AST aspects ship a JavaScript `check`
  function executed against tree-sitter parses of the node's mapped source
  files; mutual exclusion with `content.md` is enforced by the validator.
  Inline suppression honored — single-line `yg-suppress(<id>) <reason>`
  (next-line scope) and bracket `yg-suppress-disable` / `yg-suppress-enable`
  (range scope). Helper library exported from `@chrisdudek/yg/ast`.
- `yg ast-test --aspect <id> --files <paths>` / `--node <path>` for ad-hoc
  AST aspect runs without a baseline or graph attachment.
- `yg find "<query>"` — natural-language search over graph nodes and aspects.
  Indexes node names, descriptions, and `log.md` content; uses MiniSearch with
  prefix matching, fuzzy tolerance (20% of word length), and description-boosted
  ranking. Returns top-5 results with path, kind, type, description, and matched
  terms.
- `yg aspects` now shows `Reviewer` field per aspect (`llm` or `ast`).
- `yg context --file` / `--node` surfaces `check.mjs` under `read:` for
  AST aspects (previously always showed `content.md`).
- `when:` predicate on `node_type` entries in `yg-architecture.yaml` for per-file
  classification (path glob and/or content substring atoms; `all_of`/`any_of`/`not`
  operators). A type with `when` is file-classifying: every mapped file must satisfy
  the predicate. Types without `when` are organizational (parent-only; nodes may not
  have mapping).
- `enforce: strict` on node types — bidirectional enforcement. Every repo file
  matching the type's `when` predicate must be owned by a node of that type.
- `yg type-suggest --file <path>` — suggests which architecture type best matches a
  given file based on `when` predicates, ranked by satisfied-fraction with trace output.
- `yg impact --type <id>` — shows all nodes of that type, their source files, and
  (for strict types) the coverage gap: files matching `when` that are not yet mapped.
- `yg knowledge list` — lists all embedded knowledge topics with one-line summaries.
- `yg knowledge read <name>` — prints the full content of a knowledge topic.
  Nine topics ship: `working-with-architecture`, `aspects-overview`, `writing-llm-aspects`,
  `writing-ast-aspects`, `conditional-aspects`, `suppress-syntax`, `drift-and-cascade`,
  `configuration`, `cli-reference`.
- Three new `yg knowledge` topics for deep-reference material kept out of `rules.ts`:
  - `log-management` — log format constraints, Supersedes convention, typo recovery, revert with drift state, git-merge resolution, large-log delegation.
  - `ports-and-relations` — six relation types, paired events, port contracts, channel 6 propagation, defense against cross-file evasion.
  - `flows` — flow vs relation, descendant inclusion, flow-level aspect propagation, when to create a flow.
- Architecture: `enforce: strict` enabled on all classifying types except `example`, `repo-config`, and `test-fixture`. Violations resolved: narrowed `test-suite` when to exclude `source/cli/tests/fixtures/**` (fixture TS files are test data, not test suites); created `root/ci` (ci-config) node for GitHub Actions workflows and markdownlint config; created `cli/config/linters` (ci-config) node for ESLint, Vitest, and tsup configs (split from `cli/config/quality` repo-config node); updated `root/project-config` mapping to list `.github/CODEOWNERS` and `.github/dependabot.yml` explicitly rather than the broad `.github/` directory; extended `ci-config` allowed parents to include `project` in addition to `module`.
- LLM aspect `provider-redaction-cascade`: new aspect that applies to any node whose call subtree reaches an `llm-provider`. Enforces that intermediate engines, CLI orchestrators, and shared helpers do not log, persist, or expose raw prompt or response data before redaction. Uses `descendants: { relations: { calls: { target_type: llm-provider } } }` applicability filter — exercises the `descendants:` when predicate.
- `when:` applicability filters added to 6 aspects: `silent-missing-files` (parser-adapter + persistence-adapter + engine), `provider-redaction` (llm-provider + llm-subprocess-base), `atomic-write-contract` (persistence-adapter), `schema-bump-bookkeeping` (migration), `test-deterministic` (test-suite), `no-nondeterminism-direct` (engine). Prevents aspects from firing on node types where the rule cannot apply, eliminating false positives without requiring per-node suppression.
- Architecture defaults: `migration` type gains `schema-bump-bookkeeping`; `test-suite` type gains `test-deterministic`. Both are now auto-applied to all nodes of those types via architecture channel 3.
- Test cleanup: all test files that called `mkdtemp`/`mkdtempSync` without cleanup now have an `afterEach` hook (or try/finally, or a module-level safety-net `afterEach` scanning `fixtures/tmp-*`) to prevent temp dir accumulation across CI runs. Files fixed: `ast-runner.test.ts`, `build-pipeline.test.ts`, `build-command.test.ts`, `impact.test.ts`, `init-upgrade.test.ts`, `owner.test.ts`, `run-batch.test.ts`, `file-when-evaluator.test.ts`, `migrator.test.ts`, `to-4.0.0.test.ts`, `architecture-parser.test.ts` (also fixed `Math.random()` in path generation), `artifact-reader.test.ts`, `aspect-parser.test.ts`, `config-parser.test.ts`, `drift-state-store.test.ts`, `flow-parser.test.ts`, `node-parser.test.ts`, `schema-parser.test.ts`, `secrets-parser.test.ts`, `hash.test.ts`.
- `run-batch.test.ts`: removed wall-clock timing assertion `expect(order[0]).toBe('b')` — order of completion with real `setTimeout` is non-deterministic under load; the test's core invariant (results in input order) is still verified.
- `implies:` chains on 3 aspects: `cli-command-contract` → `[command-exit-codes, diagnostic-logging]`; `deterministic` → `[no-nondeterminism-direct]`; `top-level-error-handler` → `[command-exit-codes]`. Ensures implied aspects propagate automatically to nodes that carry the parent aspect.
- LLM aspect `migration-idempotent`: enforces that migrations inspect current state before acting, all write operations are idempotent (no unconditional appends or unguarded deletes), and `MigrationResult` accurately describes only what was actually changed. Applied to `migration` type via architecture defaults. Code fixes: `to-4.0.0.ts` — `rm()` calls in `processNodesRecursive` and `resetDriftStateRecursive` now use `{ force: true }`; `cleanConfig` now tracks `dirty` flag and skips write when no fields changed. `to-4.3.0.ts` — added early-return guard when version already equals `4.3.0` (formerly in deleted to-4.4.0.ts, now merged into to-4.3.0.ts).
- LLM aspect `top-level-error-handler`: enforces that `bin.ts` wraps `program.parse()` in a `try-catch` and registers an `unhandledRejection` handler — both producing `"Error: <message>\n"` on stderr and calling `process.exit(1)`. Applied to `entry-point` type via architecture defaults.
- LLM aspect `provider-retry-contract`: enforces that all LLM provider HTTP calls go through `apiFetch()` (which handles 429 retry), `verifyAspect()` catches all errors and returns a fallback `AspectResponse`, and `isAvailable()` / `getContextWindowSize()` never throw. Applied to `llm-provider` type via architecture defaults. Code fix: `ollama.ts` replaced raw `fetch()` and a hand-rolled retry loop with `apiFetch()` from `api-utils.ts`. `apiFetch()` gained an optional `timeoutMs` parameter (default 60 s) so Ollama's health-check endpoints can use a 5 s timeout.
- LLM aspect `schema-bump-bookkeeping`: enforces that migrations call `updateConfigVersion()` after all writes (and not on no-op early returns), and that `MigrationResult.actions` includes a version-update description when the call is made.
- LLM aspect `test-deterministic`: enforces that test suites are reproducible — no `Math.random()`, no wall-clock assertions, fresh temp dirs per test in `beforeEach`/`afterEach`, no ambient environment dependencies.
- Aspect `parser-contract`: renamed from `yaml-parser-contract`; content updated to cover any text format (YAML, JSON, NDJSON, plain text), not just YAML. Architecture default for `parser-adapter` type updated.
- Aspect `posix-paths-output` (LLM): new aspect split from `posix-paths` covering output boundary — paths written to stdout/stored in outputs must use forward-slash separators. Old `posix-paths` aspect removed.
- `cli/commands/find`: normalize `doc.path` with `.replace(/\\/g, '/')` before writing to stdout (posix-paths-output compliance).
- `cli/commands/type-suggest`: complete POSIX normalization on `repoRelPath` — add `.replace(/\\/g, '/')` alongside existing trailing-slash strip.
- Flow aspects (Phase 7): added `aspects:` blocks to all 7 existing flows (`validate`, `drift`, `build-context`, `graph-analysis`, `graph-navigation`, `init`, `preflight`) and created 2 new flows (`approve`, `ast-verification`). Aspects propagated: `deterministic`, `what-why-next`, `posix-paths-output`, `silent-missing-files`, `atomic-write-contract`, `provider-redaction`, `provider-retry-contract`, `provider-redaction-cascade`. Removed `cli/commands/approve` from `ast-verification` flow — it makes LLM calls and cannot satisfy `deterministic`.
- Code fixes to satisfy propagated flow aspects: `context-file.ts` and `context-node.ts` (formatters): applied `posixPath()` to all path values in output — `ownerPath`, `dep.path`, `nodePath`, `dependentPaths`, `parentPath`, `filePath`, `verifiedAgainst`, `readPath`, `mappingPrefix`; `build-context.ts`: normalize `result.file` to `displayFile` and normalize `--node` arg with backslash replace; `platform.ts` (`installRulesForPlatform`): normalize returned path; `init.ts`: normalize `path.relative()` results and add `buildIssueMessage` for both non-TTY branches (`freshInit` and `existingInit`); `tree.ts`: use `buildIssueMessage` for path-not-found error; `impact.ts`: use `buildIssueMessage` for all 5 not-found/no-coverage errors; `approve.ts` (cli): use `buildIssueMessage` in `formatRefused` and for aspect/flow not-found errors.
- Port `write-atomic` added to `cli/io/atomic-write` node: declares the `atomic-write-contract` aspect on the port; `cli/io/stores` now declares `consumes: [write-atomic]` on its `calls` relation, propagating the contract via channel 6. Path normalization fix in `core/approve.ts`: `filePath` values pushed to `changedSource`/`changedUpstream` and `tf.path` values in `sourcePathsFirst` are now POSIX-normalized before use in output and return values.
- AST aspect `no-direct-console`: enforces that engine files cannot call `console.log/warn/error/info/debug` directly — engine output must go through `debugWrite()` or formatters. Applied to `engine` type via architecture defaults.
- AST aspect `no-side-effects-on-import`: enforces that utility modules cannot execute bare top-level function calls (standalone `expression_statement` containing a `call_expression`) at module scope. Applied to `utility` type via architecture defaults.
- AST aspect `no-direct-fs`: enforces that engine and utility files cannot import `node:fs` or `node:fs/promises` directly — all filesystem calls must go through `io/graph-fs.ts` or other persistence-adapter helpers. Applied to `engine` and `utility` types via architecture defaults.
- `io/graph-fs.ts`: new wrapper exports `fileAccess`, `lstatFile`, `statPath`, `fileExistsSync` delegating to Node fs primitives; engine and utility files now use these instead of importing fs directly.
- `io/hash.ts`, `io/paths.ts`: moved from `utils/` to `io/` and reclassified as persistence-adapter (these files touch the filesystem and belong in that layer).
- `io/debug-log-writer.ts`: new persistence-adapter file containing the `appendFileSync` implementation; `utils/debug-log.ts` now accepts an injected `appendFn` parameter so the utility layer stays fs-free.
- `atomic-write-contract` AST aspect: added exemption for `debug-log-writer.ts` (uses append semantics, not atomic-write semantics — exemption is appropriate).
- `check.ts`, `type-suggest.ts`: added `debugWrite()` to outer catch blocks to satisfy the `diagnostic-logging` aspect.
- `core/approve-reviewer.ts`: fixed POSIX path normalization — `projectRoot` and `sourceFilePaths` now use `.replace(/\\/g, '/').replace(/\/+$/, '')` to satisfy the `posix-paths` aspect.
- AST aspect `no-nondeterminism-direct`: enforces that engine files cannot call `Date.now()`, `Math.random()`, or access `process.env` directly — all non-deterministic inputs must be injected as parameters by the CLI layer. Applied to `engine` type via architecture defaults.
- `logAdd` (engine): refactored `nowMs` from optional to required parameter — `Date.now()` call moved out of the engine into the CLI layer (`log.ts`). Tests updated to pass a fixed `nowMs` value for determinism.
- Bug fix: all AST aspect `check.mjs` path filter patterns prefixed with `**/` to match actual file paths (e.g. `source/cli/src/cli/log.ts`) via minimatch glob. Without the prefix, the path filter never matched and aspects were silently skipped.
- `impact.ts`: added `debugWrite()` to catch block to satisfy the `diagnostic-logging` aspect.
- AST aspect `atomic-write-contract`: enforces that persistence-adapter files use `atomicWriteFile()` instead of raw `writeFile`/`appendFile` from `node:fs/promises`. Applied to `persistence-adapter` type via architecture defaults.
- AST aspect `provider-redaction`: enforces that LLM provider files do not reference raw `prompt`, `response`, `content`, or `body` identifiers in log calls without `redactSecrets()` wrapping. Applied to `llm-provider` and `llm-subprocess-base` types via architecture defaults.
- AST aspect `command-contract-shape`: enforces that each `cli/*.ts` command file exports exactly one `register<PascalCase>Command` function. Applied to `command` type via architecture defaults.
- AST aspect `migration-bumps-version`: enforces that each `migrations/to-X.Y.Z.ts` file references the target version string matching its filename. Applied to `migration` type via architecture defaults.
- `to-4.3.0.ts`: now calls `updateConfigVersion('4.3.0')` to record the schema version bump in `yg-config.yaml` (previously updated architecture YAML without bumping the version).
- `eslint-plugin-boundaries` added to `devDependencies`; `eslint.config.js` configured with `boundaries/dependencies` rule mirroring the §4.4 `allowed_relations` table. Enforces that actual import statements match the declared architecture — CI fails on a forbidden cross-layer import before `yg check` even runs.
- `IssueMessage` type moved from `formatters/message-builder.ts` to `model/validation.ts`; `message-builder.ts` re-exports it for backward compatibility. Eliminates engine→formatter import violations detected by the new boundaries rule.
- Graph: `allowed_parents` and `allowed_relations` constraints added to all 21 classifying node types in `yg-architecture.yaml`. Relations are now validated against the architecture — forbidden relation types produce errors at `yg check` time.
- Graph: two new node types: `repo-config` (classifying, covers root/tool/CI config files) and `test-fixture` (classifying, covers self-contained mini-repos used as test data). Eliminates the 305-file unmapped-files warning.
- Graph: `cli/io/file-content-cache`, `cli/tests/fixtures` nodes added; `cli/io/parsers` and `cli/io/stores` added (split from the former `cli/io` wide node).
- `find.ts`: `debugWrite()` added to both catch blocks to satisfy the `diagnostic-logging` aspect.
- `core/approve-reviewer.ts`: new `runApproveWithReviewer()` entry point that runs LLM verification (aspects filtered to non-AST) and commits drift state on success. `LlmApproveResult` and `ApproveWithReviewerInput` types moved here from CLI layer.
- `verifyAspects` now propagates `providerError: true` from provider responses to the returned `AspectVerificationResult`, enabling caller-side provider-vs-code error classification.

### Changed

- `agent-rules.md` extended with sections: Working with architecture (pre-flight), Working with business-language requests, Per-node artifacts purpose, Log management, Finding entry points, Coordinated changes across multiple nodes. CLI commands table now lists `yg find` and `yg log` subcommands. Regenerate via `yg init --upgrade --platform <name>`.
- `DriftNodeState` extended with optional `log: { last_entry_datetime, prefix_hash }` field. Backwards-compatible — absent for nodes without log.md.
- `writeNodeDriftState` writes atomically via temp + rename.
- `yg approve` pre-LLM step now validates log integrity → format → mandatory entry. Mandatory entry requires a new log entry after every source change when `log_required: true`.
- Repositioned README, npm package description, and GitHub metadata away
  from "LLM reviewer" as the category claim toward "architecture
  enforcement / guardrails." Mechanism description retained deeper in the
  README. Added a "Too heavy? Try AutoReview" sibling-tool section with a
  comparison table and a new FAQ entry addressing the "just another AI
  code review bot?" objection. No code or behavior changes.
- `description:` is now required (hard error `description-missing`) on `yg-node.yaml`,
  `yg-aspect.yaml`, and `yg-flow.yaml`. Previously optional; omitting it now blocks `yg check`.
- `yg init` ships an empty `node_types: {}` placeholder in `yg-architecture.yaml`;
  adopters define their own types with `when` predicates.
- CLI refuses to load `yg-config.yaml` whose `version` field exceeds `"4.3.0"`. Upgrade
  the CLI when working on a repo configured for a newer schema version.
- `approve --aspect <id>`: cascade batch now evaluates only the triggered aspect per node (not all aspects) when the node has no source drift. When source files also changed, full re-verification runs as before. This reduces LLM call count for aspect-only cascade approvals.
- `context-files.ts`: `yg-flow.yaml` is no longer included in a node's tracked file set. Flow aspect propagation is already captured through aspect files (channel 3/5) — tracking the flow YAML caused false upstream drift when only the flow description was edited. Description-only flow changes now produce zero drift.
- `cli/approve.ts`: `runLlmVerification` refactored as a thin wrapper — handles AST aspects and no-provider early exit at the CLI layer, delegates LLM verification to `runApproveWithReviewer` in `core/approve-reviewer`. `LlmApproveResult` re-exported from `core/approve-reviewer` for backward compatibility.
- `rules.ts` reorganized as a lean primer + router. CLI commands trimmed to essentials in the always-loaded rules content; full reference now lives in `yg knowledge read cli-reference`. Deep log-management mechanics, port/relation grammar, and flow internals routed to the three new knowledge topics above. Mental model (graph elements, 7 channels with concrete example, drift/cascade definitions, decisions/heuristics, authorization rules for `yg-suppress`) retained in `rules.ts`. The "Where to find more" table now indexes all 12 knowledge topics.
- `aspects-overview` knowledge topic trimmed: the "7 propagation channels" summary table and "Discovering aspects in brownfield code" section removed (both now live in `rules.ts` as the killer-example mental model and the Aspect Discovery heuristic respectively).
- `suppress-syntax` knowledge topic trimmed: authorization rules (when an agent may write a suppress, who approves the reason) moved to `rules.ts` as behavioral, not syntactic, guidance.
- `working-with-architecture` knowledge topic trimmed: the "Defending against cross-file evasion (Channel 6)" section moved to the new `ports-and-relations` topic where it belongs.
- `drift-and-cascade` knowledge topic gains a "Per-node independent execution" section describing the full approve algorithm phases (integrity → format → drift → mandatory → reviewer → commit) and partial-failure recovery.
- `AGENTS.md` cleaned up: the auto-generated Yggdrasil rules block (and its `yggdrasil:start`/`yggdrasil:end` markers) removed. This repo uses only the `claude-code` platform; rules reach the agent via `CLAUDE.md` → `@.yggdrasil/agent-rules.md`. Constraints bullet updated accordingly.
- Log entry content guidance: agent-rules.md (Log management section) and `log-management` knowledge topic now require each log entry to be self-contained — no references to external artifacts (plans, design docs, scratch files, conversation history, tickets, PR descriptions), file paths or identifiers outside the entry text, plan/task/step/phase numbers, or pointers to current code state. Rationale must be embedded in prose inside the entry; stable external standards may be cited only by canonical identifier plus an inline summary of the relevant rule. Forward-only rule — existing entries are not rewritten. Regenerate via `yg init --upgrade --platform <name>`.

### Fixed

- `yg approve` now enforces mandatory log entry on first approve (bootstrap) for nodes that have source files and `log_required: true`. Previously, the mandatory check was gated on an existing baseline (`storedEntry?.log`), which caused new nodes to silently bypass the requirement. First approve without a log entry now returns `refused`; `log_required: false` continues to bypass the check.
- `yg find` now emits visible stderr warnings when log.md cannot be read (filesystem error) or is truncated (>1 MiB) — previously these were silent or debug-only.
- New validator errors for type/file consistency: `type-without-when-with-mapping`,
  `type-when-mismatch`, `type-strict-orphan`, `type-strict-misplaced`,
  `strict-overlap-conflict`, `file-mapping-gitignored`, `enforce-strict-without-when`,
  `architecture-cycle`, `type-unknown-parent`, `file-duplicate-mapping`,
  `file-unreadable`. Predicate traces are included in all relevant error messages.
- Release workflow now skips `npm publish` and GitHub release creation
  when the current `source/cli/package.json` version is already on npm.
  Previously, a non-version edit to `source/cli/package.json` triggered
  `tag-release` (which correctly no-op'd on the existing tag) but still
  reported `success`, causing the downstream `release` workflow to attempt
  re-publishing and fail with `E403 already published`.
- Knowledge topic `conditional-aspects`: corrected example field name from `default_aspects:` to `aspects:` to match actual schema field in `yg-architecture.yaml`.
- Knowledge topic `working-with-architecture`: added note that centralized test directories (e.g. `tests/`) should be excluded with `not: { path: 'tests/**' }`, not only `*.test.ts` negation.
- `yg owner --file`, `yg impact --file`, `yg context --file` — `--file` argument is now always resolved relative to the repository root, not the current working directory. Running these commands from a subdirectory no longer produces doubled paths.
- `config-parser`: `quality` field now validated with explicit type guard (throws descriptive error when not a mapping); `parallel` field validated with `typeof` guard before integer check. Aligns with `yaml-parser-contract` invariant that every required field is checked individually with a clear error message.

### Refactored

- `buildIssueMessage` import removed from all engine modules (`core/`, `ast/`, `io/`). Engines now populate `messageData: IssueMessage` only; CLI layer calls `buildIssueMessage()` for presentation. Drops deprecated `message: string` from `ValidationIssue` and `refuseReason: string` from `ApproveResult` — both fields replaced by typed `messageData`/`refuseReasonData` counterparts.
- `io/graph-fs.ts` extracted: `readSortedDir`, `readTextFile`, `readSortedDirOrEmpty` wrappers extracted from `core/graph-loader.ts` into dedicated IO module. `graph-loader.ts` no longer imports `node:fs` directly.
- `cli/io` graph node split into `cli/io/parsers` (8 YAML parsers) and `cli/io/stores` (6 fs/state adapters), eliminating wide-node reviewer context overflow.
- `core/parsing/` module extracted: `log-parser.ts`, `file-when-parser.ts`, `when-parser.ts` moved from `io/` to `core/parsing/`. These are pure in-memory parsers (no file I/O) that belong in the core layer. Consolidates the formerly-separate `cli/file-when-support` and `cli/when-support` graph nodes into `cli/core/parsing`.
- `core/migrator.ts` now routes fs access through `io/graph-fs.ts` (`readTextFile`, `writeTextFile`) instead of importing `node:fs/promises` directly. `io/graph-fs.ts` gains `writeTextFile` export.
- `core/migrator-runner.ts` extracted: version-upgrade orchestration (migration sequencing + config version update) moved from `cli/init.ts` into a dedicated core module. `cli/init.ts` retains platform-specific concerns (schema refresh, architecture file creation, rules installation).
- `core/log/` extracted: `logAdd`, `logRead`, `logMergeResolve` moved from `cli/` to `core/log/` as pure orchestration functions returning structured `IssueMessage`-shaped results. `cli/log.ts` becomes a thin presentation layer (reads `--reason-file`, loads graph, calls core, formats output). `io/log-store.ts` added as the fs adapter for log files.

## [4.2.0] - 2026-04-18

### Added

- Conditional aspects: declarative `when` predicate that filters aspect
  applicability per node against the graph. Aspects with `when=false` are
  silently skipped without invoking the reviewer. Declarable globally on
  aspects, at every attach site (node, type default, port, flow, implies),
  and supports boolean composition (`all_of`, `any_of`, `not`) over atomic
  clauses on node relations, descendants, and properties. See
  `docs/conditional-aspects.md`.
- Drift state cleanup: nodes whose effective aspect set becomes empty now
  have their drift state files removed by `yg approve`'s GC pass and by
  `yg check`'s cleanup pass.

### Changed

- `yg-node.yaml`, `yg-architecture.yaml`, `yg-flow.yaml`, and `yg-aspect.yaml`
  accept an object form (`- id: X`, `when: {...}`) in aspect attachment
  lists alongside bare strings. Bare-string form remains unchanged.
- Reviewer no longer receives aspects filtered out by `when`. Existing graphs
  without `when` behave identically.
- `yg init` detects CLI/graph version mismatch and upgrades non-optionally:
  the user selects their agent platform and `yg init` runs migrations,
  refreshes schemas, and reinstalls the platform-specific rules file in one
  step. The previous yes/no "Run migration?" prompt is gone — if the CLI
  was upgraded, the graph upgrades with it. The `--upgrade --platform` flag
  path uses the same helper and exits with a structured diagnostic when the
  config lacks a `version:` field. The existing action-menu entry
  "Upgrade rules and schemas" shares the same code path.

## [4.1.0] - 2026-04-16

### Added

- **`yg-suppress` inline aspect waiver** — source code comments with the marker
  `yg-suppress(<aspect-path>) <reason>` are honored by the reviewer as deliberate
  waivers. Agents may propose suppress markers but must never write them without
  explicit user confirmation.

### Changed

- **Agent rules rewrite** — replaced 3-section procedural format (PROTOCOL,
  REFERENCE, GUARD RAILS) with 2-section mechanics+consequences format (SYSTEM,
  DECISIONS). Same information, better internalization: consequence-driven framing
  instead of checklists, full 7-channel aspect model with ASCII diagram, CLI
  command reference table, drift/cascade explanation, cost/impact trade-off table.
- **Enriched graph schemas** — all YAML schemas (`yg-node.yaml`, `yg-aspect.yaml`,
  `yg-flow.yaml`, `yg-architecture.yaml`) now include detailed comments explaining
  each field's purpose, cascade behavior, and relation to aspect resolution channels.
- **7-channel aspect model** — documentation updated from the old 5-channel table
  to the full 7-channel model matching the implementation (Own, Ancestor, Own Type,
  Ancestor Type, Flows, Ports, Implied).

## [4.0.2] - 2026-04-15

### Fixed

- **`context --file` and `impact --file` now work from subdirectories** —
  file paths are resolved relative to CWD then made repo-root-relative,
  matching existing `owner --file` behavior. Shared via `resolveFileArg`.
- **Wide-node check now respects `.gitignore`** — `expandMappingToFiles` in
  validator used hardcoded skips (`.` prefix, `node_modules`) instead of
  gitignore. Replaced with shared `expandMappingPaths` that walks the full
  gitignore stack. Fixes false wide-node warnings from gitignored files.

## [4.0.1] - 2026-04-15

### Fixed

- **Expand directory mappings in `yg context --node`** — previously showed
  directory path as single entry instead of listing individual files.
- **Expand directory mappings in `yg approve --dry-run`** — previously showed
  0 source files for directory mappings because `readFile` on a directory
  silently failed.
- **Replace `execSync` with `execFileSync`** in check command for proper
  argument escaping. No more shell interpretation of arguments.

## [4.0.0] - 2026-04-14

### Architecture

- **Removed blackbox nodes.** All nodes are proper nodes. Nodes without
  aspects auto-approve without hashing or LLM verification — same coverage
  benefit as blackbox, zero edge cases. Anti-laundering check removed.
- **Enforcement-only model.** Aspects (content.md) are the only Markdown
  in the graph. Everything else is YAML metadata. Node knowledge lives
  in `yg-node.yaml` (description field) and aspect content.md files
  (enforceable rules). Flows are `yg-flow.yaml` only.
- **Binary approve model.** Source or upstream changed → run reviewer →
  pass or fail. The escape hatch for false positives is improving the
  aspect content.md, not bypassing enforcement.
- **Descriptive error codes.** Kebab-case identifiers (yaml-invalid,
  wide-node, source-drift, upstream-drift) instead of numeric codes.
- **Typed ports.** Nodes declare named ports with required aspects.
  Consumers reference ports via `consumes` field on relations.
  `consumes-without-ports` fires when `consumes` is declared on a
  relation to a target that has no ports.
- **Flat mapping.** Node mapping is a simple list of file/directory paths.
  Verification is handled by the LLM reviewer layer.

### Features

- **Claude Code provider (`claude-code`)** — spawns `claude` CLI for
  aspect verification. Configure via `reviewer:` section in `yg-config.yaml`.
- **`yg approve --aspect <id>`** — batch approve all cascade nodes
  from a specific aspect change.
- **`yg approve --flow <name>`** — batch approve all cascade nodes
  from a specific flow change.
- **`yg approve --node`** is variadic — accepts multiple node paths
  for batch approval. On a no-mapping parent, auto-redirects to batch
  approve cascaded children.
- **`parallel: N`** in `yg-config.yaml` controls concurrent approval
  limit (default: 1 = sequential).
- **`debug: true`** in `yg-config.yaml` enables structured append log at
  `.yggdrasil/.debug.log`.
- **Reviewer is required for approve.** `yg approve` errors if no reviewer
  is configured. Aspects are always verified — no opt-out.
- **`reviewer.context_length_field`** config option for Ollama — specifies
  the model_info key for context window size.
- **8 reviewer providers.** API: Anthropic, OpenAI, Google, OpenAI-compatible,
  Ollama. CLI: Claude Code, Codex, Gemini CLI.
  Configure via `reviewer:` section in `yg-config.yaml`.
- **Self-contained reviewer prompt.** All content (aspect rules, node
  description, source files) inline. CLI and API providers receive
  identical prompt — only transport differs.
- **Provider registry.** Self-registering providers replace switch-based
  factory.
- **Progressive disclosure in context output.** `yg context --node` shows
  overview (aspects, flows, dependents with consequence framing).
  `yg context --file` shows per-file details (aspects to satisfy,
  dependencies consumed, back-pointer to node).
- **`yg context --file`** unmapped output includes actionable next step
  with candidate node listing.
- **`yg approve`** success shows verification summary when LLM ran.
- **`yg impact`** shows cascade prediction — lists nodes that will enter
  cascade drift if the target is modified. Supports `--node`, `--file`,
  `--aspect`, and `--flow` modes.
- **`yg check`** unified gate combining structural integrity, drift
  detection, coverage, and completeness. Suggested next command shows
  one concrete step + remaining scale. Detects cascade patterns —
  suggests `--aspect` or `--flow` batch commands when >=2 cascades
  share the same cause.
- **`yg aspects`** — usage stats per aspect (by source: architecture,
  direct, implied, flow), orphan detection.
- **`yg flows`** — participant count with node names, flow aspects.
- **Interactive `yg init` wizard.** Platform selection, reviewer setup
  with model fetching from provider API, connection validation.
- **`yg init --upgrade --platform <name>`** — non-interactive rules and
  schemas refresh. Skips interactive prompts for CI and scripting use.
- **`yg-secrets.yaml`** — gitignored file for API keys. Created by
  `yg init` when an API provider is selected.
- **Append-only audit log** (`.yggdrasil/.audit-log.jsonl`) — every
  approve records timestamp, node, action, hashes, changed files.
- **Drift detection.** `source-drift` (source files changed),
  `upstream-drift` (aspects, flows, dependencies changed — collapsed
  per-node with cause identification), `unmapped-files` (coverage
  enforcement), `orphaned-drift-state` (warns about deleted nodes).
- **CLI messages** follow consistent what/why/next structure via
  `buildIssueMessage` helper.
- **`yg-architecture.yaml`** — separate file for node type definitions
  with default aspects and relation constraints per type. Created by
  `yg init` with 5 default types (module, service, library, infrastructure, data).
- **v3→v4 migration.** `migrateTo4` transforms a v3 `.yggdrasil/`
  directory: splits `node_types` to `yg-architecture.yaml`, flattens
  node aspects and mapping, removes node/flow artifacts, strips aspect
  `stability`, resets drift state. Warns about dropped aspect exceptions
  and anchors.
- **`consensus: N`** reviewer config — runs N review passes per aspect
  and requires majority agreement. Higher confidence, proportionally
  higher cost.
- **`name` field removed from `yg-config.yaml`.** Project name is
  derived from the directory name at runtime.
- **Consequence framing for dependents.** 1-5: plain list, 6-15: cascade
  warning with count, 16+: HIGH blast radius warning.

### Agent Rules

- **Greenfield graph-first workflow** — mandatory ordering: aspects
  first, then flows, then nodes. Code comes last.
- **Node sizing rule** — one node per cohesive feature area, split
  when >10 files or >3 distinct workflows.
- **Flow identification heuristic** — guidance for recognizing flows
  in specs, conversations, and code (multi-actor AND single-actor).
- **Subagent delegation protocol** — subagents must read agent-rules.md
  and deliver graph updates alongside code. Incomplete work rejected.
- **Aspect check step (5c)** in Modify Source Code workflow.
- **Aspect discovery** applies to brownfield and greenfield.
- **New file creation trigger** in agent rules.

### Fixed

- **`needsChunking` removed from `LlmProvider` interface.** All providers
  receive same self-contained prompt. Chunking is `aspect-verifier.ts`
  responsibility.
- **`verifyAspect()` simplified** from `verifyAspect(params: AspectVerifyParams)`
  to `verifyAspect(prompt: string)`. Providers are dumb pipes.
- **Reviewer prompt redesigned.** Node context replaced by one-line node
  description. Aspect content inline instead of file path reference.
- **Context output** uses `.yggdrasil/` prefix and `read:` label for aspect
  paths — agents can use paths directly without guessing the prefix.
- **Ollama context window** auto-detection works with models that use
  architecture-prefixed keys (e.g. `qwen35.context_length`).

## [3.0.0] - 2026-03-29

### Breaking

- **Artifacts removed from `yg-config.yaml`.** The three standard artifacts
  (`responsibility.md`, `interface.md`, `internals.md`) are now hardcoded in
  the CLI. The `artifacts` section is no longer read from config. Migration
  to 3.0.0 removes the section automatically. Custom artifact files remain
  on disk but the CLI will ignore them.
- **E013 and E020 validation rules removed.** E020 (missing standard artifact
  in config) and E013 (invalid artifact condition) are no longer needed since
  artifacts are hardcoded.

### Added

- **`yg build-context --self` flag.** Returns only the node's own artifacts — no
  hierarchy, dependencies, aspects, or flows. Designed for file-level graph
  updates where cross-cutting context was already loaded at task-level. Reduces
  token cost from ~8K to ~2-3K per file interaction.
- **Migration to 3.0.0.** Automatically removes `artifacts` section from
  `yg-config.yaml`. Warns if custom (non-standard) artifacts were present.

### Changed

- **Agent rules: greenfield spec-knowledge transfer (Track A).** Added
  spec-level trigger to `critical_protocol` with two-category knowledge split:
  (a) knowledge that maps to source files → node artifacts later, (b) knowledge
  that will NEVER be in source code → graph immediately. Greenfield workflow
  updated: step 0 (route spec knowledge), step 5 (every file must be mapped),
  step 6 (write `internals.md` with design decisions — as numbered step).
  Research result: 6.6 → 10.0/10.0 on spec-knowledge transfer.
- **Agent rules: brownfield context reading (Track B).** Separated task-level
  READ phase (aspects, flows, relations, parent — collect constraints before
  designing) from file-level WRITE phase (local artifacts, graph updates).
  Guard: file-level step warns if task-level READ was skipped. Research result:
  1.82 → 7.04/10 on aspect compliance.
- **Standard artifacts hardcoded in agent rules and CLI.** The three artifacts
  are referenced by name everywhere — rules, validator, context builder. No
  longer configurable.

## [2.12.0] - 2026-03-26

### Changed

- **Agent rules: task-level graph trigger.** Added a task-level trigger
  (`yg select --task`) alongside the existing file-level trigger
  (`yg build-context --file`). Root cause: agents in brainstorming/design/planning
  modes skipped graph context because the file-level trigger didn't fire — they
  didn't think of themselves as "interacting with a source file." Real-world
  impact: an agent designed a 4-feature admin panel by reading 6+ source files
  without loading graph context, missing cross-cutting aspects, flows, and
  conventions. Three changes: (1) expanded `critical_protocol` to lead with the
  task-level trigger, (2) added task-level entry to Quick Start, (3) added
  brainstorming correct/wrong example pair, (4) closed Context Assembly loophole
  ("the map alone is sufficient" → "read ALL artifact files" + measured ~8K token
  cost), (5) added 3 evasion patterns, (6) added failure state for brainstorming
  without graph.

## [2.11.0] - 2026-03-25

### Changed

- **drift:** Blackbox nodes are excluded from drift detection — no source
  hashing, no `.drift-state/` file. Existing orphaned state files are cleaned
  up on `drift-sync --all`.

## [2.10.0] - 2026-03-25

### Changed

- **Agent rules: flow creation enforcement.** Agents were skipping flow creation
  during greenfield implementation — building nodes and aspects but treating
  business processes as optional. New rules: flow identification heuristic
  (expanded to cover single-actor workflows, not just multi-actor processes),
  flow verification from specs (mandatory check per spec business process),
  flow participant maintenance (update flow `nodes` after node splits/renames).
  Added step 4b to Modify Source Code checklist (update flows after node
  restructuring). Added 3 evasion patterns and 3 failure states for flow
  omission. Root cause: agents dismissed single-actor workflows (blog
  publishing, portfolio management) as "just CRUD" rather than goal-directed
  business processes.

## [2.9.0] - 2026-03-25

### Changed

- **Agent rules v2: spec ingestion & non-code knowledge.** Major rules update driven by
  a real-world finding: during full-system implementation from external specs, the agent
  captured only ~30% of spec knowledge — all technical, zero business context. The root
  cause was a file-centric protocol with no triggers for knowledge that has no source file.
  New sections: Working from External Specifications, Non-Code Knowledge, Aspect Discovery
  During Implementation. Expanded: completeness test (3 checks), information routing table
  (6 new entries), graph audit (Step 3: non-derivable knowledge), evasion patterns (+6),
  failure states (+4). Added node sizing rule for greenfield workflows.

## [2.8.0] - 2026-03-21

### Added

- **`yg build-context --file <path>`** — resolves owning node and assembles context
  in one step. Reduces the agent workflow from two commands (`yg owner` + `yg build-context
  --node`) to one.
- **`yg impact --file <path>`** — resolves owning node and shows blast radius in one
  step. All existing flags (`--simulate`, `--method`) work with `--file`.
- **W017 wide-node** — validation warning when a node maps more source files than
  `quality.max_mapping_source_files` (default: 10). Suggests splitting into child nodes.
- **W018 source-only-sync** — `yg drift-sync` warns when source files changed but graph
  artifacts are unchanged, signaling that artifacts should be updated before syncing.

### Changed

- **Agent rules: motivation-first opening.** The `EXTREMELY-IMPORTANT` block now leads
  with why the graph matters ("the user loses time and opportunities") instead of
  authority-based compliance ("YOU DO NOT HAVE A CHOICE").
- **Agent rules: simplified Quick Start.** Replaced multi-step decision tree with single
  command: `yg build-context --file <path>`.
- **Agent rules: preflight exception removed.** "Read-only requests skip preflight" was
  exploitable — agents classified code analysis as read-only. No exceptions now.
- **Agent rules: self-audit removed.** Post-response self-audit was never executed by
  agents. Replaced by CLI guardrails (W017, W018) that provide feedback at the point of
  action.
- **Agent rules: 5 new evasion patterns.** Autonomous mode, repetitive patterns, batching,
  saving tool calls, "assumed not mapped."
- **Agent rules: 3 new failure states.** Batching graph updates, source-only drift-sync,
  wide umbrella nodes.

## [2.7.0] - 2026-03-20

### Changed

- **Context output v3.** Reorganized `yg build-context` output for agent readability:
  - `glossary` section at top — aspect and flow definitions (name, description, stability,
    participants, files) before any references
  - Inline `files` on every element (node, hierarchy, dependencies) — no separate file registry
  - `meta` (token count, budget, breakdown) moved to bottom
  - YAML comments before major sections for in-place guidance
  - `yg-node.yaml`, `yg-aspect.yaml`, `yg-flow.yaml` removed from file lists (metadata
    already in structured map)
  - `stability` (aspects) and `participants` (flows) surfaced in glossary
  - `meta.breakdown` now included in output

### Removed

- **`ArtifactRegistry` type** — replaced by `Glossary` + inline `files`

## [2.6.0] - 2026-03-20

### Added

- **Uniform `description` field.** Optional `description` field for nodes (`yg-node.yaml`)
  and flows (`yg-flow.yaml`) — provides quick orientation in context maps without reading
  full artifacts. Aspects already had this field.
- **Description in context output.** `yg build-context` now surfaces `description` for
  nodes, hierarchy ancestors, dependencies, aspects, and flows in the YAML map.
- **Description in `yg flows`.** `yg flows` output now includes `description` when present.
- **W016: missing-description warning.** `yg validate` now emits W016 for nodes, aspects,
  and flows that lack a `description` field, encouraging richer graph metadata.
- **Agent rules: description maintenance.** Rules now instruct agents to write `description`
  when creating elements and update it when purpose changes.

### Changed

- **Leaner flow refs in context output.** `node.flows` entries now contain only `path`
  and `aspects` — `name` and `description` are in the glossary.

### Fixed

- **No more YAML anchors in context output.** The `yaml` serializer created `&a1`/`*a1`
  aliases for duplicate arrays, making output harder to read. Disabled with
  `aliasDuplicateObjects: false`.

## [2.5.1] - 2026-03-17

### Fixed

- **Rules: flow field name mismatch.** Agent rules referenced `participants` as the
  flow YAML field name, but the schema and parser use `nodes`. Corrected rules to say
  `nodes`. Parser now also accepts `participants` as an alias for backward compatibility.
- **Flow loading resilience.** `loadFlows` no longer silently swallows parse errors
  from individual flows — only a missing `flows/` directory is tolerated.

## [2.5.0] - 2026-03-13

### Changed

- **Context budget: diagnostic breakdown.** W005/W006 now show token breakdown
  (own/hierarchy/aspects/flows/dependencies) instead of a single number. W006 no longer
  blocks — budget status changes from `'error'` to `'severe'`. New W015 warning fires
  when own artifacts exceed `own_warning` threshold — the only actionable budget warning.
  Token counting includes full dependency hierarchy cost.

## [2.4.1] - 2026-03-13

### Fixed

- **Agent rules: knowledge preservation under budget pressure.** W005 warning message
  reworded from "Consider splitting the node or reducing dependencies" to explicitly
  prohibit deleting knowledge from artifacts. Error Recovery gains W005 handling with
  concrete split procedure. New failure state: deleting artifact content to reduce
  context size.

## [2.4.0] - 2026-03-13

### Changed

- **Agent rules: graph as specification.** Rule 2 rewritten from "Code and graph are one"
  to "The graph is the specification; code implements it" — emphasizing knowledge
  absorption, immediate updates, and self-sufficiency. Subagent delegation now includes
  explicit deliverables (code + graph + validation). Failure states and self-audit
  aligned to "before moving to the next file" timing.
- **`yg build-context` output format.** Restructured from inline XML to a two-section YAML format:
  structural map (topology, relationships, aspects, flows) + artifact registry (file paths).
  Default mode returns paths only — agents read files individually using Read tool.
  New `--full` flag appends file contents below a `---` separator in XML-style tags.

### Added

- **Impact propagation to structural dependents.** All `yg impact` modes now show
  indirectly affected nodes — structural and event dependents (uses/calls/extends/implements/emits/listens) of
  affected nodes, with transitive chains. `--aspect` and `--flow` split output into
  "Directly affected" and "Indirectly affected" sections. `--node` adds an "Indirectly
  affected" section for reverse dependents of descendants. `--simulate` covers all sets.
- **Dependency hierarchy in context packages.** Dependencies now include their full parent
  hierarchy with ancestors' artifacts and effective aspects, giving agents domain-level
  context for each dependency.
- **`--full` flag for `yg build-context`.** Appends artifact file contents to the YAML map
  for use in environments without file reading capabilities.

## [2.3.3] - 2026-03-12

### Fixed

- **`yg tree` aspect display.** Aspects were rendered as `[object Object]` instead of
  their IDs. Now correctly extracts the `aspect` field from each `NodeAspectEntry` before
  joining.

## [2.3.2] - 2026-03-11

### Removed

- Removed deprecated `stack` and `standards` fields from config schema example
  (`graph-schemas/yg-config.yaml`). These fields were already ignored by the parser
  since v2.0.0 — this cleans up the last reference in the shipped schema template.

## [2.3.1] - 2026-03-09

### Changed

- Trigger release pipeline.

## [2.3.0] - 2026-03-09

### Added

- **`yg select --task` command:** Finds graph nodes relevant to a natural-language task
  description using weighted keyword matching (S1) with flow-based fallback (S2).
  Outputs YAML list of `{ node, score, name }` sorted by relevance. Based on
  experiment 5.4 findings (89% precision, 96% recall with keyword matching).

### Fixed

- **`yg init --upgrade` now updates config version.** Previously, `--upgrade` ran migrations
  but left `version` in `yg-config.yaml` unchanged, causing repeated migrations on subsequent
  upgrades. The version field is now set to the CLI version after migrations complete.
- **Polish text in CLI output.** Replaced Polish-language message in `yg owner` indirect
  mapping output and its example in `docs/concept/tools.md` with English.

### Changed

- **Documentation:** Updated "Early results" in README and docs with Series 5 invisibility
  experiment findings. Added "Task-Based Node Selection" section to engine spec.
  Added accelerated bootstrap and PR maintenance sections to integration spec.
- **Documentation:** Renamed `docs/idea/` to `docs/concept/`; updated all references in VitePress config, AGENTS.md, and graph metadata.
- **Documentation:** Fixed markdownlint errors in `docs/index.md` and `README.md` (MD001 heading-increment, MD026 trailing punctuation).

## [2.2.0] - 2026-03-06

### Added

- **Agent rules: semantic search navigation.** Added step 0 to Quick Start Protocol teaching
  agents to use semantic search tools (when available) for top-down navigation — going from
  a high-level intent to the right graph nodes before falling back to grep. Added corresponding
  evasion pattern for "I'll grep the codebase to find where to start."

## [2.1.0] - 2026-03-06

### Added

- **`version` field in `yg-config.yaml`:** Tracks the CLI version that created/last migrated this config. Used by the migration system to determine which migrations to run.
- **Migration system:** `yg init --upgrade` now detects project version and automatically
  migrates from 1.x to 2.0.0 — file renames to `yg-*` prefix, config transforms, aspects
  restructuring (`[id]` → `[{aspect: id}]`), and stack/standards content migration to root node

### Removed

- **Journal functionality:** Removed `journal-add`, `journal-read`, and `journal-archive` commands,
  `JournalEntry` type, journal store, and all journal references from preflight, agent rules,
  documentation, and graph. Journal was an unused feature that added complexity without value.

### Changed

- **Agent rules: graph-first enforcement.** Added `EXTREMELY-IMPORTANT` block at top of rules,
  evasion patterns table, and enhanced self-audit to prevent agents from skipping graph tools
  when working under skills (brainstorming, debugging, etc.). Split graph tool guidance into
  `build-context` (understanding) vs `impact` (blast radius assessment).
- **Per-node drift state storage:** Changed from single `.drift-state` JSON file to per-node files
  under `.drift-state/` directory. Each node's drift state is stored in its own JSON file
  (e.g., `.drift-state/cli/commands/aspects.json`). Enables readable git diffs and atomic writes.
  Old format migrated automatically on first read. `drift-sync --all` now garbage collects
  orphaned drift state files.
- **Drift state committed to git:** Removed `.drift-state` from `.gitignore` so drift state files
  are tracked in version control. CI pipelines can now run `yg drift` to verify graph-code consistency.

## [2.0.0] - 2026-03-05

### Changed

- **BREAKING:** All Yggdrasil YAML files renamed to `yg-*` prefix to avoid VS Code SchemaStore
  collisions: `config.yaml` → `yg-config.yaml`, `node.yaml` → `yg-node.yaml`,
  `aspect.yaml` → `yg-aspect.yaml`, `flow.yaml` → `yg-flow.yaml`
- **Renamed `structural_context` → `included_in_relations`** in artifact configuration. Clearer name
  for the flag controlling whether an artifact is included in dependency context packages.
- **Changed `node_types` from array to object** in config. Keys are type names, values have
  required `description` (agent guidance) and optional `required_aspects`. Symmetric with `artifacts`.
- **BREAKING:** `aspects` field in `node.yaml` changed from string array to object array — each
  entry is `{ aspect: id, exceptions?: string[], anchors?: string[] }`
- `aspect_exceptions` and `anchors` fields merged into unified `aspects` entries

### Added

- **Custom artifact guidance in agent rules:** Rules now document that `config.yaml` can define
  additional artifact types with `description`, `required` conditions (`always`, `never`,
  `when: has_incoming_relations`, `when: has_aspect:<id>`), and `included_in_relations`.
- **Unified `aspects` format in node.yaml schema:** Each aspect entry supports embedded `exceptions`
  (per-node deviations from aspect patterns) and `anchors` (code anchor assertions for staleness detection).
- **`stability` in aspect.yaml schema:** Documents the stability tier field.
- **Node type descriptions:** `config.yaml` node types now have a required `description` field
  providing agent guidance. Replaces hardcoded descriptions in rules.
- **Subagent delegation rule in agent rules:** Subagents must read `.yggdrasil/agent-rules.md`
  as their first action before any other work.

### Removed

- **BREAKING:** Removed `stack` and `standards` from `config.yaml` — technology and conventions now
  live in node artifacts at the appropriate hierarchy level
- Global context layer now contains only the project name
- **Legacy `tags`/`required_tags` fallbacks:** Removed backward-compatibility parsing of `tags`
  (use `aspects`) and `required_tags` (use `required_aspects`).
- **Legacy `node_types` string array format:** Removed support for `node_types: [module, service]`.
  Use object format with descriptions.
- `aspect_exceptions` field from `node.yaml` (merged into `aspects[].exceptions`)
- `anchors` field from `node.yaml` (merged into `aspects[].anchors`)
- Validation rule E018 (`invalid-aspect-exception`) — structurally impossible with unified format
- Validation rule E019 (`invalid-anchor-ref`) — structurally impossible with unified format
- `AspectException` type from public API

### Fixed

- **`stack` rationale reference:** Fixed misleading reference to `rationale` field on stack
  entries in agent rules (parser only supports flat string values).

## [1.4.3] - 2026-03-05

### Fixed

- **Manual publish:** Previous versions (1.4.0–1.4.2) were accepted by npm CI but silently
  removed from registry post-publish. Publishing manually without `--provenance` to diagnose.

## [1.4.2] - 2026-03-05

### Fixed

- **Release pipeline race condition:** Removed duplicate `push: tags` trigger from release
  workflow. Both `workflow_run` and `push: tags` fired simultaneously, causing two concurrent
  `npm publish --provenance` calls that likely corrupted the package on the registry.

## [1.4.1] - 2026-03-05

### Added

- **`stability` field in `aspect.yaml`:** Optional stability tier classification (`schema`,
  `protocol`, `implementation`) predicting aspect decay rate. Appears in context packages
  and `yg aspects` output. Guides review urgency: `implementation` aspects need review after
  any significant code change, `schema` aspects only when data models change.
- **W014 `anchor-not-found`** — `yg validate` warns when a code anchor is not found in a node's mapped source files
- **E019 `invalid-anchor-ref`** — `yg validate` errors when `anchors` key references an aspect not in the node's `aspects` list
- **`yg impact --method <name>` flag:** Filters node-mode impact to dependents whose
  `consumes` list includes the specified method (or have no `consumes`, meaning they consume
  everything). Enables method-level blast radius analysis.
- **Event relation tracking in `yg impact --node`:** Impact output now includes an
  "Event-dependent" section showing nodes connected via `emits`/`listens` relations,
  with event names. Total scope includes event dependents.
- **Agent rules: enrichment priority.** When adding artifacts incrementally, prioritize
  `interface.md` first (highest cross-module ROI), then `responsibility.md`, then
  `internals.md`. Based on experiment finding: 1.88 pts/1000 chars for interface vs lower
  for other artifacts.
- **Agent rules: aspect stability tiers in review cadence.** Agents use `stability` field
  to calibrate review urgency. Anchor-based staleness check during drift resolution.
- **Agent rules: action recognition rule.** New "Recognizing Graph-Required Actions"
  section ensures agents apply the graph protocol based on the ACTION being performed
  (understanding mapped code), not the SOURCE of the instruction (skill, plan, user,
  workflow). Prevents external workflows from overriding the graph-first protocol.

### Changed

- **BREAKING:** `anchors` field moved from `aspect.yaml` to `node.yaml` — anchors are now per-node, per-aspect maps (`anchors: { aspect-id: [pattern1, pattern2] }`) for more precise staleness detection

## [1.3.0] - 2026-03-04

### Added

- **`aspect_exceptions` in node.yaml:** Per-node exceptions to aspect-level generalizations.
  Record deviations from aspect patterns (e.g., aspect says "fire-and-forget" but this node
  awaits the call). Exceptions appear in context packages alongside aspect content.
- **E018 `invalid-aspect-exception` validation error:** Fires when `aspect_exceptions[].aspect`
  references an aspect not in the node's own `aspects` list.
- **Node type `infrastructure`:** New node type for guards, resolvers, middleware, interceptors,
  and validators that intercept or modify request flow without being explicitly called by
  business logic. Key for blast radius analysis.
- **Agent rules: Graph Audit workflow** — two-step protocol (consistency + completeness)
  for reviewing graph quality.
- **Agent rules: "rationale unknown" pattern** — when the rationale for a decision is unknown,
  record it as "rationale: unknown" instead of inventing a plausible-sounding rationale.
- **Agent rules: aspect lifecycle warning** — aspects decay catastrophically (~2.4-year
  half-life, binary). After significant feature additions, review all aspects touching the
  affected area.
- **Agent rules: value calibration** — Yggdrasil's primary value is cross-module context;
  invest depth where cross-module interactions demand it.

### Changed

- **Artifacts consolidated from 8 to 3:** `responsibility.md` (WHAT — identity, boundaries),
  `interface.md` (HOW TO USE — public API, contracts, failure modes, exposed data structures),
  `internals.md` (HOW IT WORKS + WHY — algorithms, business rules, state machines, design
  decisions with rejected alternatives). New repos get 3 artifacts; existing repos can migrate
  manually.
- **Agent rules: calibrated graph trust** — graph is primary source of architectural
  understanding; for implementation-level precision (exact behavior, error handling, edge
  cases), verify against source code.
- **Agent rules: failure states consolidated from 15 to 8** — removed redundancies,
  clearer grouping.
- **Agent rules: completeness test enhanced** — now includes both reconstruction test
  ("can another agent recreate this?") and omission test ("does the graph capture every
  important behavioral invariant?").
- **Agent rules: drift triage** — prioritize aspects and internals.md (highest decay),
  then responsibility.md and interface.md (most stable).

## [1.2.0] - 2026-03-03

### Added

- **`yg owner` ancestor hint:** When a file has no direct mapping but lies inside a mapped
  directory, the output now includes a second line explaining that context comes from the
  nearest ancestor and suggests `yg build-context --node <path>` for the agent.
- **Agent rules: "BEFORE ENDING ANY RESPONSE" self-audit:** Pre-completion checklist: did I
  modify code? If yes → did I update graph artifacts in this same response? Prevents agents
  from finishing without syncing the graph.

## [1.1.0] - 2026-03-03

### Added

- **`yg drift --limit <n>` flag:** Limits the number of entries shown per section, with
  truncation notice showing remaining count. Exit code still reflects all entries.
  Enables agents to page through large drift reports iteratively.
- **W013 `directory-without-node` warning:** `validate` now warns when a directory under
  `model/` has only subdirectories but no `node.yaml`, indicating a bare intermediate
  directory that may need a node definition. E015 is refined to fire only for directories
  with actual files (not just subdirectories).
- **Expense Tracker example:** Mini SaaS in `examples/expense-tracker/` with full Yggdrasil graph (API + Web nodes), auth, expenses, categories, budgets, reports, subscription mock. App UI and messages in English.
- **Examples blackbox node:** `examples/` mapped as blackbox in main graph — intentional coarse coverage.
- **`config.yaml` schema:** Added `graph-schemas/config.yaml` with documented fields for
  project name, stack, standards, node types, artifacts, and quality thresholds.
- **W012 validation rule:** `validate` now warns when mapping paths in `node.yaml` do not
  exist on disk, catching typos and stale mappings early instead of only at drift time.
- **Preflight bootstrap hint:** When `yg preflight` detects 0 nodes, it now displays an
  explicit message suggesting BOOTSTRAP MODE instead of silently reporting "clean."
- **`yg flows` command:** New command that lists flows with metadata (name, participants,
  nodes, aspects) in YAML output, parallel to the existing `yg aspects` command.
- **`yg drift-sync --recursive` flag:** Syncs the target node and all descendant nodes
  in one command. Parent nodes without mapping are skipped gracefully.
- **`yg owner` file existence hint:** When a file path doesn't exist on disk, the output
  now shows `(file not found)` to distinguish from files that exist but lack graph coverage.
- **`yg preflight --quick` flag:** Skips drift detection for faster results, useful for
  large repos where drift detection is slow.
- **`yg drift-sync --all` flag:** Syncs all nodes with mappings in one command, replacing
  manual per-node sync loops.
- **`.drift-state` in `.gitignore`:** `yg init` now includes `.drift-state` in the
  generated `.yggdrasil/.gitignore` since drift state is machine-local.

### Changed

- **E009 overlap model — "child wins":** Parent-child mapping containment overlaps are now
  allowed (e.g., parent maps `drivers/`, child maps `drivers/net/`). Only exact duplicates
  and overlaps between unrelated (non-hierarchical) nodes remain errors. Drift detection
  excludes child-owned files from parent hashing, preventing false parent drift.
- **Agent rules: "why NOT" prompting.** Rule 4 now explicitly instructs agents to capture
  rejected alternatives alongside design decisions: "Chose X over Y because Z." Added
  corresponding failure state and "when to ask" prompt for decisions without alternatives.
- **Agent rules: greenfield graph-first workflow.** Expanded the greenfield code guidance
  from a one-liner to a 6-step workflow: aspects → flows → nodes → build-context → implement.
  The graph serves as behavioral specification; code implements framework-specific HOW.
- **Agent rules: aspect identification guidance.** Added 3-instance heuristic ("same pattern
  in 3+ places = candidate aspect") and natural taxonomy: domain-specific, architectural,
  concurrency.
- **Agent rules: enhanced completeness test.** Now tests specifically for: rejected
  alternatives, correct algorithm (not simplified), ability to argue for current design.
- **`decisions.md` artifact description.** Updated across spec, config, and rules from
  generic "rationale" to "rejected alternatives — Chose X over Y because Z."

### Fixed

- **`build-context` scoped validation:** `build-context` no longer blocks on validation
  errors in unrelated nodes. Only errors affecting the target node, its ancestors, and its
  relation targets cause a build failure. Errors elsewhere are reported as informational.
- **CWD-relative path resolution in `yg owner`:** `yg owner --file <path>` now resolves
  paths relative to the current working directory before matching against graph mappings,
  so running from subdirectories works correctly.
- **`./` prefix normalization:** All `--node` and `--scope` arguments now strip leading
  `./` and trailing `/`, so `yg build-context --node ./foo/bar/` works as expected.
  Affected commands: `build-context`, `deps`, `drift-sync`, `impact`, `validate`, `drift`.
- **Drift-state garbage collection:** `yg drift-sync` now removes orphaned entries for
  nodes that no longer exist in the graph, preventing progressive performance degradation
  when nodes are created and later deleted.
- **`--scope` includes descendants:** `yg validate --scope foo` and `yg drift --scope foo`
  now include all descendant nodes (e.g., `foo/bar`, `foo/bar/baz`), not just the exact
  node. This makes scoped operations work naturally with hierarchical graphs.
- **Duplicate parent context in `build-context`:** When a child node has an explicit
  relation (e.g., `extends`) targeting its own parent, the parent's artifacts no longer
  appear twice (once in hierarchy, once in relational). The relational layer is skipped
  for ancestors since their context is already included via hierarchy.
- **Empty YAML file TypeError:** All parsers (node, aspect, flow, config) now guard
  against empty or non-mapping YAML content, producing a clear error message instead
  of a raw `TypeError: Cannot read properties of null`.
- **Preflight validation shows node paths:** Validation issues in `yg preflight` now
  include the affected node path (e.g., `[E004] cli/commands -> ...`), matching the
  format used by `yg validate`. Previously, node paths were silently omitted.
- **Scoped validate with parse errors:** `yg validate --scope <path>` now returns the
  parse error (E001) when the target node has a YAML syntax error, instead of the
  misleading "Node not found" message. Also handles scoping to children of broken nodes.

## [1.0.0] - 2026-03-02

### Added

- **`yg status` quality metrics:** New Quality section showing artifact fill rate, relation
  distribution (avg/max with node path), source mapping coverage, and aspect coverage.
- **`yg preflight` command:** Unified diagnostic combining journal, drift, status, and validation into a single report with exit code support.
- **Bidirectional drift detection:** `yg drift` now tracks changes to graph artifacts
  (aspects, flows, parent nodes, dependency context) alongside source files.
- New drift statuses: `source-drift`, `graph-drift`, `full-drift` replace the old
  `drift` status for finer-grained reporting.
- `--drifted-only` flag for `yg drift` to reduce output by hiding ok entries.
- `path` field on `FlowDef` for flow directory resolution.
- **Hierarchical aspect directories:** Aspects can be organized in nested directories under `aspects/` (e.g. `aspects/observability/logging/`). Nesting is organizational only — no automatic parent-child relationship; `implies` is always explicit.
- **`description` field in `aspect.yaml`:** Optional short description for discovery via `yg aspects`.
- **Hierarchy aspect propagation:** Aspects from ancestors (root→parent) propagate to child nodes. Child receives aspect content for all aspects in its hierarchy.
- **Flow aspects:** Optional `aspects: string[]` in `flow.yaml`. Aspect ids propagate to all participants. Validation: flow.aspects must correspond to aspect directories.
- **Context format (XML-like tags):** `yg build-context` outputs plain text with XML-like tags (`<context-package>`, `<global>`, `<aspect>`, `<flow>`, etc.) instead of Markdown. Content between tags is raw text.
- **Flow description.md format:** Required sections (Business context, Trigger, Goal, Participants, Paths, Invariants). `## Paths` must contain at least `### Happy path`; each other business path gets its own subsection. One flow = one business process with all variants. Spec in graph.md, rules.ts, tools.md.
- **Aspect composition (`implies`):** Aspects can declare `implies: [id, ...]` to pull in other aspects automatically. Enables bundle aspects (e.g. HIPAA) that include sub-aspects. Tools resolve implications recursively with cycle detection.
- **`node_types` with `required_aspects`:** Config supports `{ name, required_aspects? }` per node type. Nodes of that type must have coverage (direct aspect or via implies); W011 warns when missing.
- **Validation codes:** E016 (implied-aspect-missing), E017 (aspect-implies-cycle), W011 (missing-required-aspect-coverage).
- Enriched schema files (node.yaml, aspect.yaml, flow.yaml) with self-documenting
  YAML comments describing every field.

- **`yg impact --aspect <id>` mode:** Shows all nodes whose effective aspects include
  the specified aspect (own + hierarchy + flow + implies), with source attribution.
- **`yg impact --flow <name>` mode:** Shows all flow participants and their descendants.
- **`yg impact --node` enhancements:** Descendants section for parent nodes, co-aspect
  nodes section, effective aspects (own + hierarchy + flow + implies) instead of own-only.
- `collectEffectiveAspectIds` exported from context-builder for reuse.

### Tests

- **Enriched test fixture:** Added `requires-logging` aspect with description, `implies` chain
  on `requires-audit` → `requires-logging`, and `aspects: [requires-logging]` on checkout-flow.
- **Impact tests:** Source attribution (own, implied, flow, hierarchy), implies chain resolution,
  co-aspect node detection via implies and flow propagation, flow aspect display.
- **Integration tests:** Flow aspect propagation to participants via `collectEffectiveAspectIds`,
  aspect layers in context packages from flow propagation, implies chain resolution in fixture,
  non-participant isolation, flow layer `aspects` attribute.
- **E2E tests:** `impact --aspect` shows implies chain and source attribution, `impact --flow`
  shows flow aspects, `impact --node` shows co-aspect nodes.

### Fixed

- **Hierarchical `.gitignore` support in drift detection:** Directory hashing now discovers and
  respects `.gitignore` files at every level, not just the project root. Previously, patterns
  from nested `.gitignore` files (e.g. `*.db` in a subdirectory) were ignored during hash
  computation.
- **Missing gitignore filtering in `hashTrackedFiles`:** The drift detection hash function
  (`hashTrackedFiles`) was not applying any `.gitignore` filtering when expanding directory
  mappings, causing git-ignored files (`node_modules/`, `dist/`, `*.db`) to be included in
  drift hashes. This produced false drift on CI pipelines.
- **Path doubling in nested directory hashing:** `collectDirectoryFileHashes` was re-joining
  already-relative nested paths with parent paths, causing doubled path prefixes in hash
  digests.
- `yg impact --simulate` now reports correct baseline token counts (previously baseline
  context was missing node.yaml content due to temp directory cleanup).
- `yg impact` transitive dependency chains no longer include the target node in output.
- `hashPath` no longer skips mapped single files when they match `.gitignore` patterns — gitignore filtering applies only to directory scans.
- Reserved artifact name check uses `'node.yaml'` (the actual reserved filename) instead of `'node'`.
- Validator fallback budget thresholds aligned to spec defaults (10000/20000 instead of 5000/10000).
- `build-context` CLI fallback budget thresholds aligned to spec (10000/20000 instead of 5000/10000).
- `build-context` no longer exits with error on budget-error — always outputs context package, warns on stderr.
- `yg --version` now reads version from `package.json` dynamically instead of hardcoded value.
- Shallow artifact warning message now reports trimmed length (consistent with the check).
- **Crosscheck round 1 (31 items):** Comprehensive docs-vs-code-vs-rules audit.
- **Crosscheck round 2 (17 items):** Follow-up audit fixing remaining discrepancies across
  spec, user docs, rules template, and code.
- `package.json` `files` array pointed to renamed `graph-templates/` instead of
  `graph-schemas/` — schemas were missing from published npm package, breaking
  `yg init` for new users.
- Graph artifacts for `cli/io` still referenced `template-parser.ts` (renamed to
  `schema-parser.ts`) and `cli/core/context` described "6-step" assembly (spec is 5-step).
- Spec `tools.md` described tracked file collection as "six layers of context assembly"
  — clarified as "tracked file collection" (distinct from 5-step context assembly).

### Changed

- **Agent rules restructured:** Split into three cognitive sections (Core Protocol, Operations, Knowledge Base) optimized for LLM attention patterns. Added Quick Start Protocol, Bootstrap Mode, Drift Resolution, Error Recovery, and Escape Hatch.
- `.drift-state` format extended — entries now include hashes for both source and
  graph files that contribute to a node's context package.
- `yg drift` output split into two sections: "Source drift" and "Graph drift".
- `yg drift-sync --node` now captures hashes for all tracked files (source + graph),
  not just mapping files.
- Aspects now appear before relational context in context packages.
- Assembly algorithm described as 5-step (was 6-step) in docs and rules.
- Renamed `source/cli/graph-templates/` to `source/cli/graph-schemas/`.
- Renamed `template-parser.ts` to `schema-parser.ts`.
- Validation rule renames: `unknown-tag` → `unknown-aspect`, `broken-aspect-tag` → `broken-aspect-ref`, `missing-required-tag-coverage` → `missing-required-aspect-coverage`.
- **Documentation:** Updated all spec docs (`docs/idea/`), user docs (`docs/configuration.md`), graph metadata (`.yggdrasil/`), and agent rules to reflect aspects rename and hierarchy.
- Rules template: Quick Routing Reference now config-driven (no hardcoded artifact filenames).
- Rules template: flow description.md sections described as agent responsibility, not validated.
- Rules template: structural_context fallback documented in step 5.
- Spec: platform table in `tools.md` now shows delivery method (embed vs reference) per platform.
- **Artifact condition rename:** `has_tag:<name>` → `has_aspect:<name>` in config.yaml
  artifact conditions. Code accepts both for backward compatibility. Spec, user docs,
  and error messages updated to prefer `has_aspect:`.

### Removed

- Stale references to removed knowledge items concept from graph artifacts, spec,
  CHANGELOG, and test fixtures. Graph elements are: node, aspect, flow (no knowledge).
- Legacy flat string format in `.drift-state` (entries must be objects with `hash`
  and `files`).
- `getCanonicalHash` and `getFileHashes` helpers from drift-state-store (no longer
  needed with typed `DriftState`).

### Breaking

- **Context format:** Aspects in hierarchy/own/flow blocks via `aspects="id1,id2"` attribute; no `source` on `<aspect>`.
- **Aspects rename:** `node.yaml` field `tags` renamed to `aspects` (parser accepts both for backward compat). `config.yaml` field `required_tags` renamed to `required_aspects` (parser accepts both).
- **Aspect identifier:** `AspectDef.tag` renamed to `AspectDef.id` in TypeScript API. Aspect id = relative directory path under `aspects/` (e.g. `aspects/observability/logging/` → id `observability/logging`).
- **Context package XML:** `<aspect tag="...">` attribute renamed to `<aspect id="...">`.
- **`yg tags` → `yg aspects`:** Command renamed; output changed from plain text (one tag per line) to YAML with `id`, `name`, `description`, `implies`.
- **BREAKING:** Renamed `.yggdrasil/templates/` to `.yggdrasil/schemas/` — existing
  repositories must rename the directory manually or re-run `yg init`.
- **BREAKING:** Context package section order changed from
  Global → Hierarchy → OwnArtifacts → Dependencies → Aspects → Flows
  to Global → Hierarchy → OwnArtifacts → Aspects → Relational.
- Merged `Dependencies` and `Flows` sections into single `Relational` section.

## [0.3.4] - 2026-02-27

### Changed

- **Release workflow:** Triggers on `workflow_run` (after Tag Release) or `push` of tag `v*`. Fixes npm publish not running when tag is pushed by GITHUB_TOKEN.

## [0.3.3] - 2026-02-27

### Added

- **README:** Primary goals (build knowledge for new projects, reverse-engineer existing codebases, autonomous maintenance). Upgrade section with CLI update and `yg init --upgrade` instructions.
- **Rules:** Reverse-engineering order — when mapping existing code, create aspects → flows → model (never model before cross-cutting rules).

## [0.3.2] - 2026-02-25

### Changed

- **Optional artifacts:** rules no longer hardcode artifact names (logic, model, constraints, state, decisions). Agent reads `config.artifacts` and considers each artifact with `required: never` when creating/editing nodes. Added "Optional Artifacts — Explicit Consideration" block with interpretation of `required: never` and "don't be over-eager", plus post-node checklist.

## [0.3.1] - 2026-02-25

### Added

- **Answering Questions workflow** in rules: when the user asks about a specific file/area and the path is known, run `yg owner` + `yg build-context` and base the answer on that context (even when not modifying files). Failure state: answering about a mapped file without build-context when path is known.

## [0.3.0] - 2026-02-25

### Added

- Flow writing instruction in rules: write flow content (e.g. `description.md`) business-first — user/business perspective, technical details as inserts only
- **Flow propagation down hierarchy:** flows now attach to listed nodes and their descendants. A child node receives flow context when its ancestor (parent, grandparent, etc.) is a participant, even if the child is not explicitly listed in `flow.nodes`
- Tests for flow ancestor propagation

### Changed

- Drift handling: agent automatically runs `yg drift-sync` when drift is detected (preflight and wrap-up). No longer asks user "Absorb or Reject" — user does not need to know Yggdrasil internals
- Wrap-up trigger: added "ok" as a phrase that triggers session verification
- context-builder: `collectParticipatingFlows` now considers node + all ancestors; spec (docs/idea) updated accordingly

## [0.2.0] - 2026-02-24

### Changed

- Updated agent prompt; ran iterations to align code with graph

## [0.1.0] - 2026-02-21

### Added

- Initial release
