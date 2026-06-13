# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Unreadable mapped file no longer becomes a false green.** A file written into a node's mapping that cannot be read (e.g. lacking read permission) is now surfaced as a blocking `file-unreadable` error for every aspect, not only for aspects whose `scope.files` content filter happened to read it. Previously a plain whole-node aspect silently dropped an unreadable subject: the deterministic check ran over the shrunken (possibly empty) subject set and recorded an `approved` verdict, `yg check --approve` then crashed with a raw, unclassified read error, and a subsequent `yg check` reported PASS over a node whose source was never read. Now `computeExpectedPairs` probes the readability of every subject file and excludes-and-reports any unreadable one (so no pair is verified over content the reviewer could not see), and the per-node source fingerprint raises a typed error that positive closure catches instead of crashing — so an unreadable mapped file fails closed on both `yg check` and `yg check --approve` and stays red until the file is readable.
- **Deterministic observation-completeness holes (stale-green).** Closed several cases where a cached deterministic verdict stayed valid although something the check observed had changed. A check that read a non-subject sibling file through `ctx.node.files` (preloaded content, no `ctx.fs` call) now folds a read observation for that sibling when the subject set is narrowed, so editing the sibling re-verifies. A negative `ctx.graph.node()` lookup (node absent) now folds an absent observation, so creating that node later re-verifies. `ctx.graph.children()`, `ctx.graph.nodesByType()`, and `ctx.graph.flowParticipants()` now fold the *set membership* of the nodes they return (not just each returned node's content), so adding or removing a node from a child set, a by-type set, or a flow's participant list re-verifies. A `ctx.graph` node observation now hashes the raw `yg-node.yaml` disk bytes on both the recording and re-observation sides (lossless for non-UTF-8 files). The `ctx.fs.exists` token now classifies a non-regular, non-directory entry as `false` identically on both sides. A `ctx.fs` / parser read or list that throws after passing the allow-check now folds an absent observation before re-throwing, so a check that swallows the error and treats the path as absent re-verifies when the path later appears.

## [5.0.0-alpha.5] - 2026-06-13

> **Breaking — verdict lock redesign.** This release replaces per-node drift
> baselines with a single committed content-addressed lock and `yg check
> --approve` with no migration path. One-time upgrade on an existing graph:
> delete `.yggdrasil/.drift-state/` and run `yg check --approve` to repopulate
> the lock (one reviewer call per LLM pair; deterministic pairs are free). The
> config parser is now strict — remove any retired fields it flags
> (`quality.max_node_chars`, per-tier `references:` size caps). The entries
> below describe the target model.

### Added

- **Content-addressed verdict lock (`.yggdrasil/yg-lock.json`).** A single committed file holds every reviewer verdict — LLM and deterministic alike — as a content-addressed cache entry: `(aspect, unit) → { verdict, inputHash }`, plus a per-node source fingerprint and log baseline. A verdict is valid exactly while the inputs that produced it (rule text, subject files, and for LLM pairs the aspect/reference descriptions and resolved tier) still hash to the stored value; any input change makes the pair unverified. This replaces the per-node `.drift-state/` baselines. The lock is serialized canonically (code-point-sorted keys, one entry per line, trailing newline) so git merges align with entry boundaries, and `yg init` marks it `linguist-generated` in `.gitattributes`.
- **`yg check --approve` fills unverified pairs.** `yg check` is now a pure read — it recomputes input hashes, validates the lock, and reports, making no LLM calls and needing no provider config or keys (CI-safe). `yg check --approve` fills every unverified pair repo-wide: deterministic pairs run first, locally, for free (a node with an enforced deterministic refusal has its LLM pairs skipped that run), then LLM pairs run per tier and consensus. Real verdicts — approved and refused — are recorded; infrastructure failures write nothing and leave the pair unverified (fail closed). A recorded refusal is cached and final for unchanged inputs.
- **`yg aspect-test` — live diagnostic for either reviewer kind.** Runs a single aspect (deterministic or LLM) against a node or files without ever writing the lock. Deterministic mode supports `--check-determinism`; LLM mode supports `--dry-run` to preview the assembled prompt(s) with no calls. Every run ends with a footer noting the lock is unchanged.
- **Aspect `scope`.** Every aspect with a rule source may declare `scope: { per: node | file, files: <file predicate> }` (default whole node). `per: file` verifies each subject file independently (one pair, one prompt or `check(ctx)` call per file); `scope.files` filters which mapped files form the subject set. An aspect that excludes every file of a node it lands on produces no pair there — a legitimate vacuous pass, surfaced as a `0 files` subject count in `yg context`.
- **Per-tier `max_prompt_chars` prompt-size gate.** A reviewer tier may cap the assembled-prompt length for its LLM pairs; `yg check` reports `prompt-too-large` (with safety-ordered remedies) when a pair exceeds it. `yg init` writes `max_prompt_chars: 50000` into the generated tier. The cap is a gate, not a verdict input — lowering it never invalidates a recorded verdict.
- **Deterministic observation folds.** A deterministic verdict now records every observation the check made beyond its subject files — each `ctx.fs` read (content hash), `ctx.fs.list` (entry-name-list hash), `ctx.fs.exists` probe (including negative results), and `ctx.graph` access — folded into the pair's input hash. A later change to any observed value re-verifies the pair, so directory-listing and existence-probe rules invalidate correctly.

- **Per-scope reviewer prompt scaffolds, golden-pinned (`llm/prompt.ts`).** Extracted the reviewer prompt assembly into a dedicated module with a stable, pinned contract. `buildPairPrompt(input)` produces an XML-wrapped reviewer prompt; for `scope.per === 'node'` (the default) its output is byte-identical to the previous `buildPrompt` for equivalent inputs (golden-pinned against fixture files). For `scope.per === 'file'` it inserts an additional framing paragraph so the reviewer does not penalize missing sibling context when only a single file is shown. `assembledPromptChars(input)` measures the prompt length — the value the §4 gate checks. The legacy `buildPrompt` export in `aspect-verifier.ts` is now a thin wrapper preserving full backward compatibility.
- **Per-tier `max_prompt_chars` config field.** Tiers in `yg-config.yaml` accept an optional `max_prompt_chars: <positive integer>` field — an assembled-prompt character cap checked deterministically before the LLM call. Absent means unlimited. The field is excluded from tier identity hashing so tuning it never cascades re-approval across recorded baselines. Documented in `graph-schemas/yg-config.yaml`.

- **Expected-pair computation and source fingerprints (`core/pairs.ts`).** Introduced `computeExpectedPairs(graph)` — the read-side foundation for the verdict lock. It crosses each node's effective aspects (all 7 cascade channels, `when`-filtered) with each aspect's declared review scope (`per: node` / `per: file`, optional `scope.files` predicate) to produce the canonical set of `(aspect, unit)` pairs a lock must contain. LLM aspects exclude binary files (by extension) from their subject set; deterministic aspects keep them. An empty subject set after filtering produces no pair (vacuous pass). Aggregate and draft aspects are excluded by default; `{ includeDraft: true }` enables the full GC universe. Also introduced `computeSourceFingerprint(graph, nodePath)` — a sha256 fold over sorted `path:sha256(bytes)` pairs across a node's full mapped files (child carve-out applied, binaries included by raw bytes, scope-filter independent).

### Changed

- **`yg check --approve` replaces `yg approve`.** Verification is now part of `yg check` rather than a separate command. There is no `--node` / `--aspect` / `--flow` scoping (verification is all-or-nothing, repo-wide), no `--dry-run` (use `yg aspect-test --dry-run`), and no plan/preview or confirmation mode (use `yg impact` to predict cost). The `yg approve` command is removed.
- **`yg aspect-test` replaces `yg deterministic-test`.** The new command covers both reviewer kinds and is purely diagnostic — it never writes the lock.
- **Aspect status is rendering only.** Status no longer controls whether the reviewer runs or whether a verdict is cached. Verdicts survive `advisory ↔ enforced` flips and full `draft` round-trips with no re-verification. `draft` removes an aspect's pairs from the expected set entirely; `advisory` and `enforced` pairs are verified and cached identically and differ only in severity. The severity of an unverified pair now follows status too — advisory never blocks `yg check`, enforced always does.
- **`log_required` now defaults to `false` (opt-in).** Enable it on node types whose changes carry business intent worth capturing. When enabled, `yg check --approve` requires a fresh log entry before recording a verdict for a source change on that node — one entry stays valid through retries until the node reaches positive closure (all enforced pairs approved).
- **Lock merge is take-a-side.** Because lock entries are self-validating, resolve a `yg-lock.json` conflict by taking one side wholesale (`git checkout --ours|--theirs -- .yggdrasil/yg-lock.json`) and then running `yg check --approve`; a wrongly kept line cannot lie because its hash will not match current inputs. When both a `log.md` and the lock conflict, resolve the lock first, then `yg log merge-resolve` per conflicted log, then `yg check --approve`. Never hand-stitch lock entries.
- **One predicate grammar across three sites.** `yg-architecture.yaml` `when` (file classification), aspect `when` (node applicability), and aspect `scope.files` (review subject) share one combinator grammar with two atom families (node atoms vs. file atoms); the validator cross-hints when a file atom appears in a node-applicability `when` and vice versa.

- **`getChildMappingExclusions` consolidated into `core/pairs.ts` (single source of truth).** The function was previously duplicated between `core/approve.ts` (exported) and `core/check.ts` (private). Both copies had identical logic; `core/approve.ts` carried a `/* v8 ignore */` comment acknowledging that tests lived elsewhere. The function is now defined once in `pairs.ts`, re-exported from `approve.ts` for backward compatibility with `approve-reviewer.ts`.
- **`BINARY_EXTENSIONS` consolidated into `utils/binary-extensions.ts` (single source of truth).** Two byte-for-byte-identical copies existed in `core/checks/mapping.ts` (oversized-node budget) and `structure/runner.ts` (deterministic check file expansion). Both sites now import from the shared constant. `core/pairs.ts` also imports it for LLM subject-file binary exclusion.

### Removed

- **Per-node drift baselines and the `.drift-state/` directory.** All verification state now lives in `.yggdrasil/yg-lock.json`. The entire drift vocabulary — source drift, upstream drift, cascade as a state, "baseline" — is gone; the states are verified, unverified, and refused. Issue codes `aspect-newly-active`, `baseline-integrity`, `orphaned-drift-state`, `unapproved`, and every `*drift*` code are removed; `unverified`, `prompt-too-large`, `lock-invalid`, `log-entry-missing`, and `aspect-check-runtime-error` take their place. Upgrade by deleting `.yggdrasil/.drift-state/` and running `yg check --approve`.
- **The per-node character budget.** `quality.max_node_chars`, the `oversized-node` error, and node `sizeExempt:` are removed, along with the per-tier `references.max_bytes_per_file` / `max_total_bytes_per_aspect` caps. The per-tier `max_prompt_chars` gate replaces all of them — it bounds the same payload where it actually matters (the assembled prompt). The config parser is strict about the retired fields: a config still carrying `quality.max_node_chars` or tier `references:` caps fails `yg check` with an unknown-key error — delete those lines.
- **The "two styles" of deterministic checks.** There is one `check(ctx)` contract; a check uses `ctx.files`, `ctx.fs`, and `ctx.graph` as the rule needs. The single-file vs. graph-aware distinction is gone as a concept.

## [5.0.0-alpha.4] - 2026-06-08

### Added

- **Glob patterns in node `mapping:`, architecture `when.path`, and `coverage.required` / `coverage.excluded`.** All accept [minimatch](https://github.com/isaacs/minimatch) glob syntax: `*` matches any characters within a single path segment (does not cross `/`), `**` matches across segments. For example `Source/Database/*Repository.cs` maps only the repository files directly inside that directory (not `Helper.cs`, not subdirectory files), and `src/**/*.ts` maps every TypeScript file at any depth under `src/`. Coverage roots accept the same forms, so `coverage.excluded: ["**/*.generated.ts"]` drops generated files anywhere and `coverage.required: ["services/*/api/**"]` scopes the blocking tier to a pattern (`/` still means the whole repo). **Only `*` triggers glob interpretation** — `?`, `[ ]`, and `{ }` are treated as literal path characters, so a real filename containing them (e.g. a Next.js / SvelteKit route like `app/[id]/page.tsx`) maps literally rather than being misread as a pattern. Glob entries are resolved consistently across every file-matching surface: ownership resolution, coverage scanning, the drift baseline + reviewer source set (a glob node's matched files are hashed and sent to the reviewer, so edits to them drift and are re-verified), the deterministic runner, its `ctx.fs` allow-list and `ctx.graph` cross-node file view, `enforce: strict` backward coverage, one-file-one-node overlap detection, type-`when` classification (a glob is satisfied by the files it matches, not by the pattern string), `mapping-path-missing` validation, and source-existence drift (a glob matching ≥1 file counts as present). Plain (non-glob) entries are unchanged: an exact file path or a directory prefix that covers all files beneath it. All matching routes through a single glob engine (`utils/mapping-path.ts`), enforced by a deterministic `no-direct-minimatch` aspect so a new match site cannot silently diverge.

### Changed

- **`coverage.required: []` is now allowed and means "require nothing".** An explicit empty `required` list opts a repo into pure-advisory coverage: every uncovered file outside `excluded`/nested subtrees surfaces as a non-blocking `uncovered-advisory` warning and nothing blocks CI. Previously an empty `required` was rejected as a config error. This is intentional and visible (the full uncovered surface still shows as warnings) — not a silent disabling of enforcement. The absent-block default remains `["/"]` (require the whole repo); only an explicitly-written `[]` enables require-nothing.
- **The per-node character budget (`oversized-node`) now applies only to LLM-reviewed nodes.** The budget exists to protect the LLM reviewer's context window (a node's files are concatenated into one prompt). It now fires only for nodes with at least one non-draft LLM aspect; nodes reviewed solely by deterministic `check.mjs` aspects, and aspect-less nodes, are no longer bounded by `max_node_chars` (a deterministic check reads files programmatically, with no window). Consequence: `oversized-node` is now cascade-sensitive — adding an LLM aspect via a type default, flow, port, or `implies` can newly bring a previously-unbounded node under the budget.

### Fixed

- **Deterministic checks no longer fail spuriously under parallel `yg approve` with an `Incompatible language version 0` error.** The one-time tree-sitter runtime init and each grammar load were gated by a flag/cache set only *after* their `await`. Under `parallel > 1`, concurrent deterministic checks could all observe the not-ready state, each re-run the init/load, and one could pick up a half-initialized grammar — which web-tree-sitter reports as `Incompatible language version 0. Compatibility range 13 through 15`. The symptom was a deterministic aspect spuriously refusing a node inside a batch while passing when that node was approved alone. Init and per-grammar load are now memoized as in-flight promises set synchronously before the await, so every concurrent caller awaits the same single init/load; a failed load is evicted so a later call can retry. (A concurrency regression test asserts a cold grammar loads exactly once under 24 concurrent callers.)

- **`yg-suppress` markers are now honored in non-AST-language files.** Markers were found only by walking a file's parse-tree comment nodes, so a file whose extension has no registered grammar (`.sql`, `.md`, `.sh`, …) could not carry a working suppression — `collectSuppressions` returned nothing for it. Combined with content-only deterministic checks (which now run over such files), an author had no way to waive a specific false-positive there. Suppression now falls back to a language-agnostic raw-line scan for files without a registered grammar (the distinctive `yg-suppress(...)` token is matched regardless of comment syntax — `--`, `#`, `;`, …), in both the single-file (`yg deterministic-test --files`) and graph-aware (`yg approve`) runners. Files with a registered grammar are unchanged: their markers are still read from comments, so a marker inside a string literal is not mistaken for a real one.

- **The single-file deterministic runner delivers non-parseable files to `check()` instead of aborting.** The runner behind `yg deterministic-test --files <paths>` parsed every mapped file up front and aborted the whole run on the first file with an unregistered extension (`.md`, `.sh`, `.json`), emitting a misleading hint to delete that file. This contradicted the documented promise that content-only checks may iterate non-parseable files, and disagreed with the graph-aware runner used by `yg approve` (which already passes such files with `ast` undefined). A file whose extension has no registered grammar is now delivered to `check()` with `file.ast === undefined` so text/regex rules run over it; the `ctx.files` `ast` field is correspondingly optional. A grammar that should load but fails still fails closed.

- **`aspect-status-downgrade` now compares against the aspect's own default status.** The guard that rejects an attach site declaring a weaker enforcement level than an aspect already guarantees previously folded only the *other* attach sites into its baseline, omitting the aspect's declared default `status:`. A lone attach site naming a level below the aspect default therefore escaped detection and silently weakened enforcement. The baseline now always includes the aspect default, matching the effective-status rule (`max()` across every channel including the default), so any downgrade below the guaranteed level is blocked.

- **`when` predicates keyed on a bare consumed port are validated against real ports.** A conditional-applicability predicate referencing a port that exists nowhere in the graph is a graph error, but the check only fired for the paired relation-and-port shape; the bare `consumes_port` shape slipped through unvalidated. Both shapes now resolve against the full set of declared ports and report an unknown port (`when-unknown-port`) regardless of how the predicate is spelled.

- **`openai-compatible` tier without an `endpoint` is now a config error instead of a silent fallback to the public OpenAI host.** A tier using the generic `openai-compatible` provider with no `endpoint` previously fell back to `https://api.openai.com/v1` — a surprising and potentially data-leaking destination. It now fails `yg check` with `config-tier-endpoint-missing`. Providers that ship a safe default host (e.g. `ollama` → `http://localhost:11434`) are unaffected and still need no explicit endpoint.

- **Inline `yg-suppress` markers are detected inside multi-line comment blocks.** The marker-matching expressions anchored end-of-text without multi-line semantics, so a marker on any line other than the last of a multi-line comment was silently ignored — the documented multi-line and bracket-disable placement forms did not take effect. Matching is now line-aware and finds a marker on whichever line it appears.

- **A relation's `consumes` must be a list.** A scalar or mapping in the `consumes` position of a relation is malformed and previously slipped through parsing to confuse downstream port-consumption logic. It is now rejected at parse time with a clear message.

- **`quality.max_direct_relations` is validated as a positive integer.** A zero, negative, or fractional value is meaningless as a fan-out count; it is now rejected at parse time with a clear message, matching the existing guard on `max_node_chars`.

- **Port-contract and relation-target codes are classified as structural.** `port-missing-consumes`, `port-undefined`, `port-missing-aspect`, `consumes-without-ports`, and `relation-target-forbidden` are graph-integrity failures but were not listed among the structural codes, so they did not group and block consistently with their peers. They are now included.

- **An explicit `reviewer.type: aggregate` is accepted when it agrees with the inferred kind.** An aspect that only `implies` others (no `content.md`, no `check.mjs`) has inferred kind `aggregate`; spelling that kind out explicitly previously failed parsing because only `llm` and `deterministic` were valid `reviewer.type` strings. The parser now treats an explicit `aggregate` as valid alongside the other two, provided it agrees with the inference — consistent with how an explicit `llm`/`deterministic` must agree with file presence.

- **Bundled knowledge and schema docs corrected to match runtime behavior.** Several shipped docs diverged from what the CLI actually does: the `yg-architecture.yaml` schema now states that a missing type `when` predicate is a fatal architecture-invalid error (the whole type system is rejected); the `ports-and-relations` knowledge topic now distinguishes the unconditional `aspect-undefined` reference-integrity check from the consumption-gated `port-missing-aspect`, and describes the missing-port-contract error in what/why/next prose instead of quoting a stale literal block; the `configuration` topic clarifies that `endpoint` is required only for `openai-compatible` (no default host) while `ollama` defaults to `http://localhost:11434`; and the `writing-deterministic-aspects` topic corrects the `findComments` helper signature to `(file) => TreeNode[]` (it operates on a single file, with language derived from the file path).

## [5.0.0-alpha.3] - 2026-06-08

### Added

- **Scoped coverage adoption (`coverage.required` / `coverage.excluded`).** `yg check` no longer forces every tracked file to be mapped. A new optional `coverage` block in `yg-config.yaml` declares which roots must be fully covered (`required` → error), which are ignored (`excluded` → silent), with everything else a non-blocking warning. Subtrees that contain their own nested `.yggdrasil/` are auto-skipped by every repo-walking check, so a monorepo overlay (`apps/.yggdrasil`) is governed by its own graph without the root graph complaining about it. The default (`required: ["/"]`) reproduces the previous always-map-everything behavior.

## [5.0.0-alpha.2] - 2026-06-03

### Removed

- **`max_tokens` config field and prompt chunking.** The `max_tokens` field has been removed from reviewer tier configuration and the chunking/truncation mechanism that split large nodes across multiple reviewer calls has been removed. The reviewer now always sends a node's source files in a single prompt; the per-node character budget (`quality.max_node_chars`) is the sole gate preventing oversized contexts. Adopters who had `max_tokens` in their `yg-config.yaml` should remove the field; `yg init --upgrade` will strip it automatically.

### Fixed

- **`yg check` always re-hashes content, ignoring stored mtime.** Previously `yg check` reused a stored per-file hash when the on-disk mtime matched the stored mtime. A content edit followed by `touch -r` (restoring the original mtime) would produce a false "no drift" result, letting changed code pass the gate silently. The check gate now always reads and hashes each file's content from disk; the mtime-based optimization is preserved only on the approve-time path (the trusted write operation).

- **Dangling-aspect diagnostics emit POSIX-clean paths.** The `next:` hint for an undefined-aspect reference no longer prints a trailing slash (`Create aspects/<id>/ …`). It now reads `Create the aspects/<id> directory …`, satisfying the output-path normalization rule (trailing slashes stripped from any path written to stdout) while still making clear a directory must be created.

- **Tamper-proof verdicts in the drift hash.** Each aspect's recorded verdict (`approved` / `refused`) and its error-source discriminator are now folded into the canonical drift hash. Previously a stored verdict was unprotected plaintext in `.drift-state/*.json`: hand-editing a committed `refused` to `approved` would silently pass `yg check`. Now any such edit changes the recomputed hash and is reported as drift, forcing a re-approve. The free-text refusal `reason` is intentionally excluded from the fold (it is human-facing prose, not part of the red/green outcome). The stored hash is recomputed AFTER the reviewer's verdicts are applied so approve and check agree; existing baselines re-key losslessly (their preserved verdicts are folded on migration). Adopters on a pre-existing `5.0.0-alpha` baseline will see a one-time drift on first `yg check` after upgrade and must re-approve affected nodes.

- **`yg check` blocks on an unattributable baseline hash divergence (`baseline-integrity`).** The verdict-fold above is now actually enforced at the gate. Previously `yg check` recomputed the canonical hash but, after detecting a divergence, only emitted an issue when it could attribute the change to a modified source file or a graph-identity change — a verdict-only tamper (hand-editing `refused` → `approved` while leaving `hash` untouched) changed neither, so the divergence was computed and then silently dropped, and `yg check` returned clean. The gate now emits a blocking `baseline-integrity` error for any hash divergence with no file or identity cause: the recorded baseline can no longer be trusted (a verdict was tampered, or the baseline predates a hash-scheme change). Both causes resolve the same way — `yg approve --node <path>` to re-establish the baseline, or restore the drift-state from git.

- **`yg suppressions` no longer reports marker mentions in generated docs as active waivers.** The scan skipped nothing, so a `yg-suppress` reference inside the generated rules file, a node `log.md`, the changelog, or any prose doc was listed as if it were a live waiver — pure noise. The scan now skips everything under `.yggdrasil/`, generated rules mirrors (`.cursor/`, `.github/copilot*`, `.windsurfrules`, `.clinerules`), any `log.md`, and prose files (`.md` / `.mdc` / `.markdown` / `.txt`), so the inventory lists only genuine code-side waivers. Still read-only and always exits 0.

### Added

- **`yg suppressions` command.** A new read-only command that inventories all active `yg-suppress` markers in the repository's source files. Lists each marker's aspect path, location, reason, and kind (single-line, bracket, or wildcard). Exits 0 always. Emits non-blocking warnings for unknown aspect-ids (the path does not resolve to any known aspect), wildcard suppresses (`*`, which silently waive any future aspect added to the codebase), and unbounded ranges (a `yg-suppress-disable` marker with no matching `yg-suppress-enable`). Useful for auditing accumulated waivers before a release or a new aspect rollout. Does not affect `yg check` or any drift baseline.

- **Language-aware `yg-suppress` scanning.** The suppress scanner now resolves comment nodes per the source file's language (as registered in the language registry), so `yg-suppress` markers in Rust (`//`, `/* */`), Java (`//`, `/* */`), Kotlin (`//`, `/* */`), and all other built-in grammars are correctly detected. Previously only TypeScript/JavaScript comment node shapes were recognized, so markers in other languages were silently ignored by the deterministic reviewer.

- **Directory-mapped deterministic aspects now run.** The structure runner's `buildOwnFiles` now expands directory-glob mapping entries (e.g. `src/handlers/**`) into the full set of matching files, so a deterministic aspect attached to a node that uses directory-based mapping patterns receives all the node's files — not just explicitly-listed entries. Previously, only nodes with explicit file-by-file mappings had their files materialized for the deterministic runner; directory-mapped nodes got an empty file list and the aspect silently produced zero violations.

- **AST-walk guard in the deterministic runner.** The runner now skips files whose extension has no registered tree-sitter grammar (leaving `file.ast` as `undefined`) rather than crashing with an unhandled error. `check.mjs` authors who use `file.ast` must guard with `if (!file.ast) continue;` — the knowledge documentation already shows this pattern. Files without an AST are still passed to the check so content/regex rules that only touch `file.content` continue to work.

- **`node-types.json` files shipped with the CLI.** Each built-in grammar now ships its `node-types.json` under `dist/grammars/` (e.g. `tree-sitter-typescript.node-types.json`). `check.mjs` authors can inspect this file to discover grammar node types and field names without a separate install. The knowledge topic `writing-deterministic-aspects` documents the path convention.

- **Fail-closed on LLM aspect with zero readable source files.** When `yg approve` resolves to zero readable source files for an LLM aspect (for example, a node whose mapped files are all empty after carve-out), the approve now exits 1 and writes nothing to drift state instead of silently committing a false-green baseline. This prevents a configuration error (a mis-mapped node) from permanently suppressing enforcement.

- **Aggregating aspect kind.** An aspect that ships neither `content.md` nor `check.mjs` but declares `implies:` is now a valid third kind — a content-less, check-less named bundle with no own reviewer and no own verdict. The reviewer kind is INFERRED from rule-file presence and normalized onto the in-memory model so `reviewer.type` is always one of `llm` / `deterministic` / `aggregate`: `content.md` ⇒ `llm`, `check.mjs` ⇒ `deterministic`, neither-file-with-`implies` ⇒ `aggregate`. An explicit `reviewer.type` (where present) still wins and must agree with the files (enforced by the validator). An aspect with neither file and no `implies` is rejected (`aspect-reviewer-missing` at parse, `aspect-empty` at validation) since it can never produce a verdict; an aggregate that ships a rule source is rejected (`aspect-unexpected-rule-source`); `references:` on an aggregate is rejected (`aspect-references-on-aggregate`). An aggregating aspect is effective on a node (so its implied children expand via the implies channel) but is excluded from every verdict-expecting path — it is never dispatched to a reviewer, never carried forward, and never surfaces as `aspect-newly-active`. This keeps individual aspects atomic (one `content.md` = one rule = one clean binary verdict) while letting a multi-rule contract decompose into one aggregating parent plus N atomic children.

## [5.0.0-alpha.1] - 2026-06-01

First public prerelease of the 5.0.0 line. Published under the `alpha` dist-tag — `npm i @chrisdudek/yg` continues to resolve the stable release; this build is only installed by an explicit `@chrisdudek/yg@alpha` / `@5.0.0-alpha.1`.

### Added

- **Fail-closed lower schema-version gate.** `loadGraph` now throws `OutdatedSchemaVersionError` when the on-disk graph version is older than the CLI's supported version (5.0.0). Previously, graphs with a version field below 5.0.0 were silently parsed; now the CLI refuses immediately with a structured what/why/next message and exits 1, directing users to `yg init --upgrade`. This is the symmetric lower bound to the existing upper-bound refusal (`UnsupportedSchemaVersionError`). The gate is caught in `preamble.loadGraphOrAbort` and rendered via `buildIssueMessage`; it does not crash with a generic stack trace.
- **E2E coverage for the typed drift-state format gate.** A subprocess suite (`cli-drift-state-format.test.ts`) spawns the compiled binary against a baseline with an absent, wrong, or current-but-corrupt `schemaVersion` (and per-required-field omission, wrong-typed fields, and a JSON-primitive baseline), asserting the exact refusal message, exit code, and that the gate fires identically from both `yg check` and `yg approve`.
- **E2E coverage for drift-state baseline migration via `yg init --upgrade`.** The migrations subprocess suite (`cli-migrations.test.ts`) now also spawns the binary to prove the command re-keys on-disk baselines: a flat synthetic-key baseline becomes typed with pre-verdict approved-synthesis, a baseline already carrying verdicts has them preserved verbatim, an unparseable baseline is deleted and withholds the version bump (exit 1) then recovers on a re-run, and an already-typed baseline is skipped byte-identically (idempotent).
- **E2E coverage for `yg-aspect.yaml` field and reviewer-block validation.** A subprocess suite (`cli-aspect-yaml-validation.test.ts`) spawns the binary against a standalone aspect that is malformed in exactly one way — missing name, out-of-vocabulary status, non-array implies, invalid implies status_inherit, scalar (non-mapping) reviewer, reviewer mapping without type, unknown reviewer key, or empty/non-string reviewer tier — asserting each surfaces its specific structural code and blocks `yg check` (exit 1).
- **E2E coverage for duplicate mappings and orphaned drift state.** The check-validation matrix (`cli-check-validation.test.ts`) now also proves a source file mapped by two nodes is rejected with `file-duplicate-mapping` (exit 1), and that a structurally-valid baseline whose node has left the graph surfaces as a non-blocking `orphaned-drift-state` warning with `yg check` still passing (exit 0).
- **`mapping-escapes-repo` validator (B3).** A node mapping that resolves outside the repository root — an absolute path, or one that climbs above the root with a `..` segment — is now a blocking structural error. The mapping-path normalizer only converts separators and strips a leading `./` and trailing slashes; it does not collapse `..`, so without this guard a mapping like `../../etc/passwd` would resolve against the project root and let a node claim files outside the project, bypassing coverage and aspect enforcement. Added to the structural code set (always blocks `yg check`).
- **Getting-started "core vs. advanced" tiering (G3).** A new closing section names the four concepts needed day-to-day (node, aspect, `yg check`, `yg approve`) plus aspect status, defers the cascade mechanisms (inheritance, type-defaults, `implies`, flows, ports, `when`) as "reach for these only when a rule must scale past one node", and surfaces that you never trace the cascade by hand — `yg context --file` prints every effective aspect and where each came from.
- **Batch-approve cascade selection extracted to a coverage-counted module (D1).** The pure cascade-node / cascade-aspect selection helpers (`filterCascadeNodes`, `filterFlowCascadeNodes`, `filterAspectCascadeNodes`, `selectDriftedAspects`) moved from the `cli/approve.ts` command wrapper into a new `core/approve-cascade-select.ts` engine module (and `cli/core/approve-cascade-select` node). They were already unit-tested, but `cli/**` is excluded from coverage (the thin Commander wrappers are verified end-to-end instead), so their tested behavior was invisible to the coverage metric. The command re-exports them, so callers and tests are unchanged; branch coverage rose to 90.23%. (`cli/init.ts`, the other large `cli/**` file, is genuine interactive-wizard glue — its substantive logic already lives in `core/migrator*` — so it correctly stays excluded.)
- Internal: the pure per-aspect verdict construction/merge helpers moved from the reviewer-orchestration engine into a new `approve-verdicts.ts` module (and `cli/core/approve-verdicts` node), and the POSIX path-normalization structure tests into their own `reviewer-structure-posix` node, to keep each node's reviewer context within the per-node size budget.
- Test-coverage hygiene closing three reviewer/merge-resolve branches: the `structure-implies` integration suite gains a case proving an enforced implier with `status_inherit: strictest` promotes an advisory-default implied aspect to enforced on the consumer (a violation then BLOCKS rather than warns); the `log-merge-resolve` unit suite gains the **plural** "entries" message branches (multiple dropped and multiple fabricated entries) and the no-prior-baseline write path (a valid merge with no existing drift-state writes a fresh baseline from scratch). `scripts/repo-check.sh` now hard-fails if `dist/bin.js` is absent after the build step, so the spawned-binary E2E suites (which self-skip via `describe.skipIf(!distExists)`) can never silently no-op over zero coverage.
- **Per-language E2E coverage for the AST grammars** (`cli-ast-languages`). A single hermetic suite spawns the real built binary and runs a deterministic aspect whose `check.mjs` receives `file.ast` for a source file in **each of the 16 built-in grammars** (TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, JSON, Kotlin, YAML, TOML) — language auto-detected by extension. For every language it asserts the parse produced a non-empty named tree, and that per-language comment configuration works (`findComments` locates a marker comment written in that language's own syntax; JSON correctly finds none). This catches a missing/renamed grammar WASM, a wrong extension mapping, or wrong comment-node types through the real packaged parser — gaps the registry unit tests cannot see.
- **Multi-language AST support** for deterministic (`check.mjs`) aspects. Beyond TypeScript/TSX/JavaScript, the built-in tree-sitter grammars now cover **Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, and JSON** (Tier-1 + JSON). Each grammar ships a prebuilt `.wasm` from its per-language npm package (a devDep), copied into `dist/grammars/<wasmFile>` at build and resolved by the parser by that name in both dev and published installs. Per-language `commentTypes` and `commentDelimiters` (which drive `findComments()` and the `yg-suppress` scanner) were verified by parsing a sample with each grammar — Rust and Java use `line_comment`/`block_comment`, PHP recognizes `//`, `#`, and `/* */`, Python and Ruby use `#`, JSON has no comments. The pack-and-smoke gate now parses a `.ts`, a `.py`, and a `.go` file through the **packaged** grammars (not the dev `node_modules` fallback), so a missing or renamed WASM for any language fails CI rather than the user. **Kotlin, YAML, and TOML** are also included (their grammars come from the `@tree-sitter-grammars` npm scope; Kotlin uses `line_comment`/`block_comment`, YAML and TOML use `#`), bringing the built-in set to 16 grammars. Grammar-version pinning (`grammarCommit`) remains a later determinism enhancement.
- E2E coverage of five command-surface output paths not previously exercised: `yg impact --node` rendering the **Event-connected** section (emits/listens blast radius, distinct from structural deps), `yg owner --file` distinguishing a non-existent path with the explicit "(file not found)" suffix, `yg find` reporting "Empty graph, nothing to search." on a graph with zero searchable elements, `yg context --file` on an unmapped file suggesting sibling nodes mapped in the same directory, and `yg aspects` marking an aspect used by no node as "Used by: 0 nodes — orphaned". Each verified present in `src/cli/*` and absent from the e2e corpus before pinning.
- E2E coverage of the last unpinned channel combination — `own-default` status inheritance THROUGH a port-sourced implies edge (channel 6 → channel 7), added as `cli-ports-inheritance` B6. The enforced charge-port aspect implies an advisory-default aspect with `status_inherit: own-default`, so the implied aspect keeps its own advisory default on the consumer (a violation warns, does not block) instead of inheriting the implier's enforced status that the default `strictest` mode would propagate. With this, every aspect-propagation channel (1–7), cascading `implies` (recursive expansion, cycle detection, per-edge `when`, both `status_inherit` modes, draft-implier gating, nested global-`when` gating), and architecture-driven type-default propagation (channels 3/4 + classification + `when` validation) is proven end-to-end against the real binary.
- E2E coverage of three structural validation codes not previously exercised through the spawned binary, added to `cli-validation-codes`: `implied-aspect-missing` (an aspect's `implies` list naming an id with no aspect directory), `overlapping-mapping` (two non-hierarchical nodes whose directory mappings overlap, which the ancestor-descendant "child wins" rule does not excuse), and `node-yaml-missing` (a `model/` directory holding files but no `yg-node.yaml`). Each code was verified present in `core/checks/*` and absent from every other e2e suite before being pinned. (`duplicate-aspect-id` was found to be structurally unreachable via the filesystem — an aspect id is its relative path under `aspects/`, so two directories can never collide — and is left to unit coverage.)
- E2E coverage push toward 100% of the aspect-propagation mechanics — two further hermetic suites (9 tests) closing the last channel and cascade-cause gaps. `cli-channels-completion` proves the under-exercised propagation paths end-to-end: a DRAFT implier does not pull its implied aspect into the effective set (and flipping it to enforced does), an intermediate implied aspect whose global `when` is false is excluded AND its own nested implications are never reached, a flow listing the PARENT module reaches the child service with `(via parent …)` provenance and enforces, a flow listing only one leaf participant does not reach a sibling leaf, and an aspect authored with NO explicit `status:` field resolves to the enforced default and blocks. `cli-cascade-causes` pins the agent-facing cascade cause messages for the synthetic tracked keys that lacked message-level assertions: editing an aspect's metadata (its description, not its `check.mjs`) cascades to every using node as "the definition of aspect '…' changed"; adding a relation re-derives a node's own metadata as "node '…' own metadata changed"; two simultaneous causes on one node are both surfaced and cleared by one approve; and deleting one of several mapped files raises source-drift that clears when the file is restored byte-identically.
- Comprehensive E2E sweep (wave 3) — six further hermetic suites (73 tests) closing the last functional gaps toward complete coverage. `cli-channels-status` (advisory/draft status arriving via the cascading channels — own-type default CH3, ancestor-type default CH4, with `max()` across a draft contributor and an enforced flow); `cli-channels-multilevel` (ancestor aspects reaching a grandchild two generations down with correct attribution, the `when` relation-atom matrix across uses/extends/implements/emits/listens, cross-channel `when` AND-composition, the `status_inherit: own-default` branch); `cli-ports-inheritance` (parent-port consumed by a child of the consumer, an implies chain seeded by a port-sourced aspect crossing channel 6→7, transitive propagation through a consumer chain, port description validation); `cli-flows-errors` (flow-definition and filesystem error paths — missing/empty name, malformed participant/aspect lists, missing/unparseable/directory `yg-flow.yaml`); `cli-log-remaining` (the `Supersedes` convention, large-log `read --top`/`--all`, remaining add/read/merge-resolve error branches); `cli-aspect-authoring-remaining` (reference-file modification cascade, the graph-aware ctx parse helpers on valid/malformed input, aspect-removal baseline cleanup). Surfaced one finding recorded in `.temp/dogfood-report.md` (several flow filesystem-load errors are misclassified as "No .yggdrasil/ directory found" or unclassified aborts rather than a flow-specific what/why/next).
- Comprehensive E2E sweep (wave 2) — five further hermetic suites (81 tests) closing the remaining paths in the higher-coverage domains. `cli-commands-surface` (the remaining flag-mutex, resource-not-found, required-subcommand, and bad-value contracts across the command surface); `cli-channels-extended` (`when` filtering on ancestor-node / ancestor-type inherited aspects and implies edges, relations/descendants atoms on cascade channels, status `max()` with a draft contributor); `cli-flows-extended` (multiple flow aspects propagating independently, `approve --flow --dry-run`, post-baseline child auto-inclusion, participant removal, flow-YAML parse errors, empty/multi listing); `cli-migrations-config-extended` (the platform rules-file installer matrix, legacy/malformed reviewer migration edges, secrets withhold-bump, config-coercion edges); `cli-suppress-deterministic-remaining` (hierarchical aspect-id matching, empty-reason rejection on single-line and bracket markers, draft→advisory flip activating a previously-inert suppress, comma-separated multi-id markers, block-comment markers).
- In-process mock-reviewer E2E infrastructure (`tests/e2e/support/mock-reviewer.ts`) that speaks the Ollama wire protocol (`/api/tags`, `/api/show`, `/api/chat`) on an ephemeral loopback port, capturing every verdict request, paired with an async-spawn `runAsync` helper (a synchronous spawn would freeze the event loop and deadlock the in-process server). This makes the entire LLM-reviewer mechanism testable hermetically and deterministically in CI — no Ollama, no real model. The companion suite `cli-llm-reviewer-mock` (13 tests) proves the machinery end-to-end against the real spawned binary: an approve verdict records a baseline and a refuse blocks with the reason surfaced; consensus N issues exactly N calls and aggregates by majority (verified on 2-1 and 1-2 splits); the verifier prompt carries the aspect id, the content.md, the node path, and the source; a non-200 or unparseable response degrades to a provider-error fallback that blocks; a draft aspect is never sent (zero calls) while an advisory refusal does not block; `--dry-run` never calls the reviewer; a source edit re-invokes it on re-approve; and the request carries the configured tier model. A companion `cli-llm-reviewer-mock-extended` (6 tests) covers the larger-input and mixed paths: token-budget chunking splits source across multiple reviewer calls; a node mixing a deterministic and an LLM aspect calls the reviewer only for the LLM one; several LLM aspects each consume their own call; a 429 is retried once then succeeds; and a refused LLM verdict renders in `yg check` as a blocking error (enforced) or a non-blocking warning (advisory) without re-calling the reviewer. Closes the largest remaining E2E blind spot — the LLM reviewer path was previously only exercisable against a live Ollama or a dead endpoint.
- Comprehensive E2E sweep (wave 1) — eight further hermetic suites (159 tests) closing the lowest-coverage functional domains, each spawning the real `dist/bin.js` against from-scratch in-temp graphs. `cli-architecture-classification` (type-when-mismatch across path/content/not atoms, strict backward coverage, organizational-type-with-mapping, channel-3/4 default-aspect attribution and enforcement, the full `type-suggest` surface); `cli-architecture-when-validation` (type-undefined, type-unknown-parent, parent-type cycle, enforce-strict-without-when, the `when`-predicate validation error matrix); `cli-ports-extended` (multi-port provider/consumes, advisory/draft port aspects, port `when`, port-definition cascade, port-undefined on removal); `cli-relations-extended` (the six relation-type matrix, event pairing/multi-pair/self-pair, relation-broken, self/organizational targets, add/remove cascade, bare-relation non-propagation); `cli-aspect-authoring` (rule-source XOR, the deterministic check.mjs runtime contract via approve and `deterministic-test`, implies-edge `when`, `when` on relation/descendants atoms); `cli-aspect-status-extended` (effective-status `max()` with draft, default-to-enforced, multi-node cascade on a status flip, refused-verdict persistence, transitive `status_inherit`); `cli-drift-cascade-extended` (cross-node check-touched cascade, batch partial-failure independence, cascade-only-no-log, all-draft skip, multi-cause, partial-deletion recovery); `cli-log-gate-extended` (mandatory-log gate triggering and status-independence, `log_required:false`, vacuous first approve, fenced/duplicate log-format edges, node-path syntax rejection). The sweep surfaced seven product findings recorded in `.temp/dogfood-report.md` (all-draft node bypassing the log gate; a draft implier still propagating its implied aspect; a fence-unaware `parseLog`; an advisory↔enforced flip not being node-hash-stable; and three cosmetic cascade-cause naming gaps) — every test pins actual behavior and stays green whether or not these are later fixed.
- Two further hermetic E2E suites completing the flow and suppress coverage. `cli-flows-advanced` proves the advanced flow-channel mechanics — a conditional flow aspect (`when` predicate) reaches only the matching participants, an advisory flow-aspect violation renders as a non-blocking warning while an enforced one blocks, a draft flow aspect stays dormant, and the flow-set cascade is honored (adding an aspect to a flow, or adding a participant, fires `aspect-newly-active` on the affected participants and clears via `approve --flow`/`--node`). This authoritatively confirms the flow-set cascade is NOT silent — only a cosmetic flow-file comment/description edit fails to cascade, which is correct. `cli-suppress-forms` proves the `yg-suppress` syntactic forms against the deterministic reviewers: an unterminated `yg-suppress-disable(<id>)` waives through end of file, a single-line `yg-suppress(*)` waives every aspect on the line below, a misspelled aspect-id is a silent no-op while the correct id waives, a named bracket waives only its own aspect, and the graph-aware structure runner honors markers identically to the single-file runner. (Recorded in `.temp/dogfood-report.md`: deterministic reviewers scope suppress strictly by line, whereas the LLM reviewer is instructed to scope contextually — a difference the suppress-syntax knowledge topic does not yet spell out.)
- Expanded end-to-end coverage closing the remaining functional gaps for the 5.0.0 release — seven further hermetic suites that spawn the real `dist/bin.js`, all in-temp with no committed fixtures. Port channel-6 enforcement proven end-to-end (a refused port aspect blocks the consuming node, the previously-unproven security guarantee); LLM tier-identity cascade (editing a tier's config drifts only the nodes whose aspects resolve to that tier); the ancestor-node and ancestor-type channels with effective-status `max()` across cascading channels; the graph-aware deterministic `ctx` surface (own files, fs, graph, parsers, allowed-reads boundary); the full reviewer-configuration validation matrix (provider/consensus/tier-name/default-tier/reviewer-block/legacy-and-mixed-shape/quality/parallel rejections plus `aspect-tier-on-deterministic` and `aspect-tier-unknown`); structural validation codes not previously exercised through the spawned binary (aspect-reference escape/duplicate/invalid-form/blank-path/empty-array/too-large, reviewer-spec parse errors, `parent-type-forbidden`, `type-strict-orphan`, `structural-cycle`, `sizeExempt` opt-out); and extended log-integrity coverage (append-only prefix-modified and boundary-missing refusals, log-format datetime/header/code-fence/ordering violations, `log add` symlink/hardlink/reason-file guards, `log read` validation, and merge-resolve dropped/fabricated/altered-entry tamper paths).
- Comprehensive end-to-end test coverage for the 5.0.0 release. A deterministic fixture repo (`tests/fixtures/e2e-lifecycle`) plus a ports fixture (`tests/fixtures/sample-project-ports`), and nine hermetic E2E suites that spawn the real `dist/bin.js` and prove the documented mechanics: the full approve lifecycle (fresh approve, source-drift refusal, re-approve, advisory/draft/enforced status, `yg-suppress` waivers, `--aspect` batch); every cascade layer (aspect content + reference file, parent/hierarchy, relational dependency, flow); relation + event-pairing enforcement; port channel-6 propagation and the four port error codes; flow channel-5 propagation to participants and descendants; the `yg check` validation/error-code matrix; the mandatory-log gate, level-2-heading reason rejection, `log read --top` validation, and `log merge-resolve`; and the migration paths (`init --upgrade`, idempotency, withheld-bump, ast→deterministic, version-too-new); the conditional `when` predicate (atoms + `not`/`any_of`/`all_of`, applicability gating enforcement); implied aspects (channel 7 — recursive expansion, enforcement of an implies-only aspect, `status_inherit`, cycle reporting); and the headless greenfield/init paths (scaffold, the platform rules-file matrix across six platforms, the greenfield approve lifecycle, empty-repo and guard cases). A companion `cli-ollama-reviewer.external.test.ts` (run via `npm run test:external`, excluded from CI) proves the LLM reviewer path works end-to-end against a real Ollama endpoint.
- `yg deterministic-test` command — runs a `deterministic` aspect's `check.mjs` without recording a baseline, for iterative aspect development. Two modes: `--node <path>` runs the graph-aware check against a named node's mapping; `--files <paths...>` runs an ad-hoc single-file check with no graph attachment. `--check-determinism` (available in both modes) runs the check twice and exits 1 if violation sets differ (lexically sorted), detecting side effects in `check.mjs` before they cause flaky CI. Graph-level violations (no `file`) render as `<graph>: <message>`; file violations group by path and sort by line. Architecture allows `command` nodes to call both `ast-adapter` and `structure-adapter`.
- Agent rules: added a "Past entries are not a template" paragraph to the "Log management — workflow" section of `source/cli/src/templates/rules.ts`. The paragraph names log-entry mimicry as a failure vector and tells the agent not to copy the surface style of prior log entries that reference plans, tasks, phase numbers, section markers, or file paths in their bodies, even when surfaced via `yg log read`. Complements the existing self-containment rule with a behavior override at the decision point where in-context priming from contaminated historical entries previously dominated. Regenerated `.yggdrasil/agent-rules.md` via `yg init --upgrade --platform claude-code`.
- `yg context --file` and `yg context --node` now render the effective aspect status next to each aspect id as `<id> [<status>]`. When the resolved status is `draft`, the formatter emits a `(reviewer skipped; aspect is draft)` notice in place of the aspect's `read:` lines (both the aspect content path and any reference paths), since draft aspects do not reach the reviewer. Enforced and advisory aspects retain the full `read:` list. Aspects without an explicit status default to `enforced` in the rendered tag.
- `yg impact`, `yg aspects`, `yg find`, and `yg context` now surface aspect enforcement status (draft / advisory / enforced) inline. `yg aspects` renders `[<status>]` next to each aspect id from the aspect-default. `yg find` adds a `status: <enum>` line for aspect-kind results. `yg impact --aspect` annotates each directly affected node with its effective status on that node, and `yg impact --node` includes the effective status next to each aspect on the `Aspects:` summary and `Nodes sharing aspects` listing. `buildNodeContextData` and `buildFileContextData` populate a new optional `status` field of type `AspectStatus` on every aspect entry so downstream formatters can render it without recomputing. `IndexedDocument` gains an optional `status` field (populated for aspect kind only) and stores it in MiniSearch `storeFields`.
- `clearDraftAspectsFromDriftState(yggRoot, nodePath, aspectIdsToClear)` in `io/drift-state-store.ts` — removes specified aspect IDs from the per-node baseline's `aspectVerdicts` map. `approve-reviewer.ts` wraps every `commitApproval` call in a `commitApprovalAndCleanDrafts` helper that collects effective-draft aspects for the node and evicts their stored verdicts after commit, so verdicts recorded under a prior approve do not linger in the baseline after an aspect transitions to `draft` (dormant) status. No-op when the node has no stored state, no `aspectVerdicts` field, or no overlap with the requested IDs; the field is dropped entirely when removal empties the map.
- `DriftNodeState.aspectVerdicts: Record<string, AspectVerdict>` — per-aspect verdict captured at approve time. `AspectVerdict` carries `verdict: 'approved' | 'refused'` plus, for refused entries, the `reason` and `errorSource` (`codeViolation` | `provider` | `astRuntime`). Verdicts are recorded for every non-draft effective aspect that the reviewer evaluated. `approve-reviewer.ts` now writes the baseline EVEN on refused branches so downstream commands can render per-aspect refused state from the stored baseline without re-running the reviewer. In a filtered approve (`--aspect <id>`), prior verdicts for untouched aspects are preserved by merging new verdicts on top of the stored baseline's verdicts; in an unfiltered approve, the new verdicts fully replace the prior set.
- `yg check` now renders findings by aspect status. New issue codes: `aspect-newly-active` (error — a non-draft effective aspect has no baseline verdict on a node; emitted on status flip, new attach, or fresh aspect), `aspect-violation-enforced` (error — refused baseline + enforced status), `aspect-violation-advisory` (warning — refused baseline + advisory status). Per-node short-circuit now uses `hasNonDraftEffectiveAspects` so nodes whose every effective aspect resolves to draft skip drift detection entirely; the drift-state GC predicate uses the same helper so dormant baselines are reaped on the next check. Legacy baselines (written before `aspectVerdicts` existed) are tolerated as "implicitly approved" so the 5.x upgrade does not flood the user with `aspect-newly-active`. `CheckResult` adds `advisoryWarnings` and `draftSkipped` tallies surfaced as a footer block under the result line. `suggestedNext` prefers an error's `next` field over a warning's, so an enforced violation outranks a co-emitted advisory.
- Validator: `aspect-status-downgrade` detects when an explicit attach-site declares an aspect status lower than the cascading anchor (max of other channels, falling back to the aspect default). Covers all six explicit channels — own, ancestor node, own arch type, ancestor arch type, flow, port. Cascaded defaults remain anchors and are never flagged themselves; only explicit overrides that would silently weaken enforcement are surfaced as errors via `aspectStatusDowngradeMessage`.
- Aspect reference files: LLM aspects may declare `references:` in `yg-aspect.yaml` to provide supporting context (lookup tables, catalogues) to the reviewer prompt and to the agent under `read:`. Includes per-tier size limits (`references.max_bytes_per_file`, `references.max_total_bytes_per_aspect`) in `yg-config.yaml`, drift cascade on reference file edits, and validator rules `aspect-reference-broken`, `aspect-reference-too-large`, `aspect-reference-escape`, `aspect-reference-duplicate`, `aspect-references-on-deterministic`, `aspect-reference-invalid-form`, `aspect-reference-blank-path`, `aspect-references-empty-array`.
- `parseAspect` now returns `ParseAspectResult` (discriminated union `{ ok: true; aspect }` | `{ ok: false; aspectId; errors }`) instead of throwing on invalid reviewer shapes. Structured error codes: `aspect-reviewer-missing`, `aspect-reviewer-legacy-string`, `aspect-reviewer-not-mapping`, `aspect-reviewer-type-missing`, `aspect-reviewer-type-invalid`, `aspect-tier-on-deterministic`, `aspect-reviewer-unknown-key`, `aspect-reviewer-tier-invalid`. Legacy string form (`reviewer: llm`) is no longer silently accepted — it returns `aspect-reviewer-legacy-string`.
- `graph-loader.ts`: `loadAspects` propagates `ParseAspectResult` failures into `Graph.aspectParseErrors` instead of silently dropping them. Aspects that fail to parse are excluded from `graph.aspects`.
- New engine node `cli/core/reviewer-tiers` with three source files: `tier-identity.ts` (canonical JSON for LLM tier drift detection), `tier-selection.ts` (aspect-to-tier resolution supporting explicit and default tier), `format-version.ts` (v4/v5 config and aspect YAML shape detection predicates).
- New test-suite node `cli/tests/unit/core/reviewer-tiers` with unit tests for tier-identity, tier-selection, and format-version.
- Language registry in `source/cli/src/core/graph/language-registry.ts` — the single source of truth for extension→grammar resolution; phase 1 covers typescript/tsx/javascript; phase 3 expands to 35. `deterministic` aspects detect each source file's language by extension through this registry, so no per-aspect `language:` declaration is needed.
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
- `deterministic` reviewer type (`reviewer.type: deterministic`) — the single programmable-check type alongside `llm`. A `deterministic` aspect ships `check.mjs` and runs locally with a graph-aware `ctx` (own files, fs, graph, parsers; language detected by extension) at zero LLM cost. Enables both single-file syntactic rules and graph-aware structural rules through the one runner. Integrates with aspect-status v5, drift cascade, suppress, and 7-channel propagation. Constrained graph/fs reads — the graph stays the source of truth for dependencies. Trust model — main-thread execution, no sandbox.
- `yg knowledge read writing-deterministic-aspects` topic — the unified guide to authoring `deterministic` aspects, covering both the single-file (tree-sitter) and graph-aware (`ctx`) styles.
- First dogfood graph-aware `deterministic` aspect `sibling-test-file` — every CLI command source has a sibling unit test under `cli/tests/unit/cli/`.
- **Reviewer tiers** — `yg-config.yaml` now uses `reviewer.tiers.<name>` (named tier blocks). Each tier declares `provider`, `consensus`, and `config`. Aspects target a tier via `reviewer: { type: llm, tier: <name> }`; aspects without `tier:` use `reviewer.default` (required when more than one tier is configured; optional with exactly one tier). Supported providers: `ollama`, `anthropic`, `openai`, `google`, `openai-compatible`, `claude-code`, `codex`, `gemini-cli`.
- `resolveExecutionPlan` in `approve-reviewer.ts` — groups effective aspects into `{ kind: 'deterministic' }` or `{ kind: 'llm', tier, tierName }` entries using `selectTierForAspect`. Tier resolution errors produce structured `IssueMessage` failures that abort `yg approve` before any LLM call.
- `runApproveWithReviewer` now executes `deterministic` aspects first (no LLM call), grouped and run locally. LLM aspects follow, batched per tier name — one provider instance and one `verifyAspects` call per tier. Infrastructure errors (provider/auth) are distinguished from code violations in the refusal reason.
- Migration `to-5.0.0`: `transformConfigReviewer` converts the legacy flat-provider reviewer block to `reviewer.tiers` — one tier per legacy provider key, named after the provider; `reviewer.active` is renamed to `reviewer.default` (omitted when only one tier results). `transformAspectReviewer` converts `reviewer: <string>` to `reviewer: { type: ... }`. The migration follows a **collect-all policy**: walk every aspect, transform what is unambiguous, leave unrecognized values untouched, and emit a structured warning per problem file. When ANY warning is emitted, `MigrationResult.bumpVersion` is `false` and the runner withholds the version bump — fix the listed files and re-run `yg init --upgrade`. `migrateSecretsFile` is inspect-only: a non-credential field under `yg-secrets.yaml` (anything other than `api_key`) emits a warning and withholds the bump. Multi-provider configs without `reviewer.active` STOP migration before aspects are touched, preserving a recoverable state.
- Migration `to-5.0.0` adds an inspect-only `addAspectStatusDefaults` pass (lives in `source/cli/src/migrations/aspect-status-defaults.ts`, called at the end of `migrateTo50`) that surfaces v5 status-default surprises without rewriting source files. Two warnings are emitted: `aspect-status-migration-escalation` — an aspect whose default is `enforced` implies another aspect with a lower default (`advisory` or `draft`) via a bare string or `{id: B}` without `status_inherit`; under v5's `strictest` propagation the implied aspect will silently promote to `enforced` when reached via the implier. `aspect-status-migration-downgrade` — an explicit per-attach-site `status:` is strictly below the cascading anchor (max of aspect-default and all other channels contributing the same aspect onto the same node). Either warning withholds the version bump; the migrator runner already gates `bumpVersion` on `warnings.length === 0`. The pass parses each YAML directly so it remains robust to pre-v5 parse rules and never invokes the graph layer.
- `yg init` now writes v5 `reviewer.tiers` shape when configuring a new reviewer. Default config version set to `5.0.0`.
- Knowledge topic `configuration` updated with v5 `reviewer.tiers` reference, multi-tier example, and secrets format.
- Docs `configuration.md` and `reviewers.md` updated for v5: tiers reference, correct `yg-aspect.yaml` `reviewer:` object syntax, and consensus-per-tier examples.
- Docs: new `aspect-status.md` deep-reference for adopters — three-level lifecycle (`draft`/`advisory`/`enforced`), declaration sites across channels, max() rule, implies propagation with `status_inherit` (`strictest` default vs `own-default`), drift mechanics, migration from 4.x. Wired into VitePress sidebar. `core-concepts.md` gains an "Aspect status" subsection under Aspects. `reviewers.md` notes that effective-draft aspects are skipped before reviewer dispatch. `cli-reference.md` adds the aspect-status issue codes (`aspect-status-invalid`, `aspect-status-downgrade`, `implies-status-inherit-invalid`, `aspect-newly-active`, `aspect-violation-enforced`, `aspect-violation-advisory`) and a `yg approve` draft-skip note. `conditional-aspects.md` gains a `when` vs. `status` callout. `getting-started.md` recommends starting new aspects at `status: advisory`. `index.md` gains a four-feature highlight on the three-level lifecycle. `showcase.md` adds a `status:` feature section with strictest-vs-own-default examples.

### Changed

- The release workflow publishes to npm via OpenID Connect (OIDC) trusted publishing instead of a long-lived `NPM_TOKEN` secret. The GitHub Actions job authenticates with a short-lived OIDC token (`permissions.id-token: write`) and provenance is generated automatically, so there is no stored npm credential that can expire or leak. The job upgrades to an OIDC-capable npm (`>= 11.5.1`) before publishing, since the pinned Node ships an older npm.
- The release workflow now publishes prerelease versions under their prerelease dist-tag instead of `latest`. The dist-tag is derived from the package version: a prerelease (`5.0.0-alpha.1`) publishes under its identifier (`alpha`, or `beta`/`rc`) and is installable only via an explicit `@chrisdudek/yg@alpha`, while a stable `X.Y.Z` still publishes under `latest`. Previously `npm publish` ran with no `--tag`, which defaults to `latest` even for a prerelease version — that would have made the alpha the default `npm i @chrisdudek/yg` install, contradicting the prerelease's own promise that the stable release stays the default. The GitHub release created for a prerelease version is also flagged as a prerelease, so it does not surface as the repository's latest release.
- **The migration runner is now the sole writer of the project's `version` field.** Individual migrations no longer write `yg-config.yaml`'s `version` themselves; the runner (`core/migrator-runner.ts`) advances the version exactly one step per successfully-completed migration and is the only code path that touches the field. A migration still withholds the bump by returning `bumpVersion: false` when it emits recoverable warnings the user must resolve first, and each migration emits an action line announcing the runner will bump the version to its target so the user-facing summary stays unambiguous. This removes the previous redundant per-migration self-write (which duplicated the runner's job and risked bypassing the warnings gate) and collapses the `schema-bump-bookkeeping` enforcement rule from two acceptable patterns to a single invariant: a migration must not write the version itself. Migration content transforms, warning semantics, and the no-bump signal are unchanged — only which code writes the version moved.
- **Drift-state baseline is now a single typed on-disk format (typed identity + required per-aspect verdicts).** A baseline (`.yggdrasil/.drift-state/<node>.json`) carries an explicit `schemaVersion`, a typed `identity` block (`ownSubset`, per-dependency `ports`, and a per-aspect `aspects` map holding `meta`/`tier`/`checkTouched`), and a REQUIRED `aspectVerdicts` map (may be `{}`). This replaces the prior scheme that stuffed synthetic `own-subset:`/`aspect-meta:`/`tier-identity:`/`check-touched:`/`port-aspects:` string keys into the file-hash map and treated `aspectVerdicts` as optional. The drift-state store validates `schemaVersion === 1` and the typed shape at read time, throwing `OutdatedDriftBaselineError` (pointing at `yg init --upgrade`) for any baseline that predates this format — a second net behind the graph-loader version gate; on write it stamps the current version. The canonical drift hash is computed by a single shared helper (`computeCanonicalHash`, folding the real-file hashes with the typed identity via an order-independent serialization), used by both the runtime and the pure re-key transform (`core/drift-state-rekey.ts`) so a re-keyed baseline over unchanged inputs matches a fresh computation. Aspect `status` stays excluded from the identity (an advisory↔enforced flip does not drift; the recorded verdict carries forward), and `mtimes` remain a non-hashed perf fast-path. The legacy `isLegacyBaseline` / `aspectVerdicts === undefined` guards are removed and cascade attribution is now typed (an `IdentityCause` discriminator) rather than parsed from a synthetic key string. The drift-cause diff/description helpers were extracted into `core/drift-cause.ts`, keeping `core/check.ts` and the `core/graph` node within the per-node reviewer-context budget.
- **`yg init --upgrade` to 5.0.0 now carries drift-state baselines forward losslessly instead of resetting them.** The `to-5.0.0` migration adds a pass that re-keys every on-disk baseline (`.yggdrasil/.drift-state/**/*.json`) from the old flat synthetic-key shape into the typed format, recomputing the canonical hash over the same logical inputs so a clean `yg check` over unchanged source sees no drift and no re-approval is required (the v4-era "delete all baselines" reset is reserved for the safe-degradation path only). A pre-verdict baseline (one written before per-aspect verdicts existed, so it carries no `aspectVerdicts`) has each aspect present in its re-keyed identity recorded as `approved`, reproducing "the aspects effective at the last approve were approved" rather than flooding the first post-upgrade check with newly-active aspects; a baseline that already carries `aspectVerdicts` (even `{}`) is preserved verbatim. A baseline that cannot be parsed or re-keyed is deleted (so its node surfaces as drift and the adopter re-approves just that node) with a warning naming the file — a partially-transformed baseline is never written. The pass is idempotent: a baseline already at the current `schemaVersion` is skipped untouched, so re-running an interrupted upgrade changes nothing. The pure re-key transform (`core/drift-state-rekey.ts`) stays I/O-free; the approved-synthesis, corrupt-file deletion, and warning-gated version bookkeeping live at the migration boundary.
- **Runtime parsers are now single-format (5.0 only); legacy-shape detection is migration-only.** `format-version.ts` has been relocated to `core/format-detect.ts` — the two predicates consumed by the migration (`to-5.0.0.ts`) are `isCurrentConfigFormat` (to skip already-migrated configs) and `isLegacyAspectReviewer` (to detect and rewrite string reviewer fields). Legacy and mixed config-shape detection (`isLegacyConfigFormat`, `isMixedConfigFormat`) has been removed: a malformed v5 config now yields a generic current-format error — `config-tiers-missing` (reviewer mapping without a `tiers:` key) or `config-reviewer-unknown-key` (unrecognised key under `reviewer:`). The runtime config parser no longer checks for the old reviewer shape: a mapping without a `tiers:` key (whatever its old shape) falls through to `parseReviewer` and emits the existing generic `config-tiers-missing` error ("reviewer.tiers is missing or not a mapping"). The aspect parser no longer has a `typeof raw === 'string'` branch: a string `reviewer:` field falls through to the existing `aspect-reviewer-not-mapping` branch. The now-unreachable codes `config-reviewer-legacy-format`, `config-reviewer-mixed-format`, and `aspect-reviewer-legacy-string` have been removed from `STRUCTURAL_CODES` and `APPROVE_GATING_CODES`. The fail-closed version gate (5.0.0) ensures all graphs are at the current format before any parser runs, making this safe.
- CI now runs the full `repo-check.sh` gate on a **Node version matrix** (`22` and `24`) instead of only Node 22, so a version-specific regression fails CI rather than an adopter; both legs were verified locally (build + 2833 tests pass on each). Codecov uploads from a single leg to avoid duplicate reports. The hardcoded `node-version: 22` in `release.yml` and `docs.yml` was replaced with `node-version-file: .nvmrc`, so the canonical Node version lives in one place. (Remediation finding E1.) The external real-Ollama integration lane (`*.external.test.ts` / `npm run test:external`) is now explicitly documented as the manual complement to the in-process mock suites that cover the reviewer mechanics hermetically in CI; the file is typechecked in CI so it cannot bitrot. (Remediation finding E3.)
- ESLint `@typescript-eslint/no-explicit-any` is now an **error** (was `warn`). `repo-check.sh` does not fail on warnings, so a `warn` let future `any`-leaks pass CI silently; the codebase is `any`-free today. (Remediation finding I3.)
- Documented that **LLM reviewer verdicts are non-deterministic** (H1) in `docs/reviewers.md`: the same code can flip SATISFIED↔NOT SATISFIED between runs — most often on borderline rules or when a file is re-reviewed after an unrelated edit — and the mitigations (concrete/decidable rules, preferring deterministic `check.mjs`, raising `consensus`, re-running approve on a one-off flip).
- Documented that Codecov is **advisory by design** in `ci.yml` (`fail_ci_if_error: false`): the binding coverage gate is `repo-check.sh`'s 90% threshold on lines/statements/functions/branches, which already fails the job; Codecov adds reporting/PR-trend annotations only, so a flaky upload must not fail CI over coverage that is already enforced. The `docs.yml` workflow already uses `npm ci` (not `npm install`). (Remediation finding E2.)
- **Relocated the command-layer support helpers + new `command-support` node type (B4).** `loadGraphOrAbort` and `abortOnUnexpectedError` moved from `formatters/cli-preamble.ts` to `cli/preamble.ts`. They must reach both the engine (`loadGraph`) and the formatters (`buildIssueMessage`), and only the command layer may legally depend on both — keeping them in `formatters/` was an upward dependency on the engine that the layering rules forbid. Because every `cli/*.ts` file was previously a `command` (the type's `when` requires a `register<X>Command` export) and these helpers register none, a minimal new `command-support` node type was added (`cli/*.ts` **without** a register export) so the helper is classified and enforced without being mistaken for a command handler. The 14 command handlers now import it from its command-layer location; `impact.ts`'s constant-text error sites were also normalized to the canonical `Error: …` prefix form the contract mandates. Prerequisite for activating ESLint boundary enforcement.
- **Relocated the when-predicate parsers to the utility layer (B6).** The pure file-level and aspect-level `when`-predicate parsers (and the shared boolean-clause helper) moved from `core/parsing/` to `utils/`. The io-layer file parsers need them, but the layering rules forbid io→engine; the parsers are pure (they transform already-parsed objects, no file I/O), so the leaf utility layer — which any layer may import — is their correct home and makes the io dependency legal. The `log.md` entry parser stays in `core/parsing/` (only the engine imports it). Prerequisite for activating ESLint boundary enforcement.
- **Single POSIX path-normalization helper (I1).** The hand-inlined `…replace(/\\/g, '/')` idiom (and its trailing-slash-strip companion) — previously copied ~99 times across 37 files — is consolidated behind `utils/posix.ts`: `toPosix(p)` (separators only) and `toPosixPath(p)` (separators + strip trailing slash). Every call site now reads by intent and the normalization rule lives in one place. The helper bodies are byte-identical to the expressions they replace; the full suite passes unchanged. (The bespoke `normalizeMappingPath`, which also strips a leading `./`, keeps its own pipeline.)
- **Honest "sandbox" wording (F1).** The deterministic (`check.mjs`) reviewer's allow-listed read set is now described everywhere as a read *discipline* that scopes which files count as tracked dependencies — **not** a security sandbox. `check.mjs` runs in the main Node process with full privileges; an adversarial check could still write files or open sockets. Reframed in `docs/cli-reference.md`, the `aspects-overview` and `writing-deterministic-aspects` knowledge topics, and the internal read-resolver comment; added an explicit "only run aspects you trust" note.
- **`yg find` "Matched:" line (G4).** Deduplicates matched terms case-insensitively and caps the rendered list (with a `(+N more)` suffix), so fuzzy/prefix expansion no longer dumps a long, noisy stem list. The `findCommand` body also drops its redundant inner try/catch so unexpected errors flow through the single canonical `abortOnUnexpectedError` funnel in the action handler (the documented command-contract path). (Remediation finding G4.)
- Programmable aspects are now a single declared reviewer type: `reviewer.type` is `{ llm, deterministic }`. A `deterministic` aspect ships `check.mjs` and runs locally through the one graph-aware **structure runner** (own files, fs, graph, parsers; language detected by extension) at zero LLM cost — there is no separate `ast`/`structure` distinction at the declaration level. Internally both former kinds resolve to the one `deterministic` execution path in `approve-reviewer.ts`. The `to-5.0.0` migration maps a legacy `reviewer: ast` string to `{ type: deterministic }` (alongside `reviewer: llm` → `{ type: llm }`). The dead `dispatchAstAspects` dispatcher and the `runAstAspect`/`AstRunnerError` import are removed from the approve path; `ast/runner.ts` itself is retained as the engine for the `yg deterministic-test --files` ad-hoc single-file mode. `yg approve --dry-run` routes the deterministic preview through `runStructureAspect` so the preview matches the verdict real approve produces. The interim `yg ast-test` / `yg structure-test` commands and the separate `writing-ast-aspects` / `writing-structure-aspects` knowledge topics are consolidated into the single `yg deterministic-test` command and the `writing-deterministic-aspects` topic; the reviewer docs describe one deterministic reviewer with two usage styles. Accepted behavioral differences vs the old AST runner: an unknown-extension or syntax-error file no longer throws a dedicated AST error (the structure runner leaves `ast` undefined / attaches the error tree and runs); these aspects now record a `structureTouchedFiles` footprint for their own files; and the structure runner's `buildOwnFiles` excludes child-mapped paths and materializes only explicit-file mapping entries (it does not walk directory mappings — every real programmable-aspect node maps explicit files). Suppress (`yg-suppress`) and violation shapes are shared, so enforcement is unchanged for the dogfood's 14 deterministic aspects. The per-kind validator codes are collapsed to one set: `aspect-references-on-deterministic` (was `aspect-references-on-ast` / `-on-structure`) and `aspect-tier-on-deterministic` (was `aspect-ast-tier-not-allowed` / `aspect-structure-tier-not-allowed`). No version bump — 5.0.0 stays.
- `yg approve` now re-verifies only the aspects whose dependencies actually changed and carries the rest forward, instead of re-running every effective aspect on a drifted node. The optimization applies to every approve where `--aspect` is not passed (`--node`, the `--flow` cascade, and the no-mapping parent-redirect path). A **source-file** edit is node-global and still re-runs every effective non-draft aspect (each aspect reads all of the node's source). An **aspect-only** cascade — a change to one aspect's `content.md` / `check.mjs` / `yg-aspect.yaml` / a reference file / its synthetic identity — re-runs just that one aspect; the node's other aspects keep their prior baseline verdict with no reviewer call. A `no-change` approve now performs zero reviewer calls. Behavior is conservative: any drift not cleanly attributable to a specific aspect (hierarchy, relational/port, flow, or a bare cross-node `structure-touched` path) re-runs every aspect, so a verdict is never carried forward when the dependency it judged actually moved. Implemented via a new `selectDriftedAspects` drift-attribution helper feeding an optional `reReviewAspectIds` dispatch filter in `runApproveWithReviewer` (the existing per-aspect `carryForward`/`aspectVerdicts` baseline machinery is reused unchanged). This makes broad deterministic cascades — and the `ast → deterministic` type migration's re-approval — far cheaper. The aspect-dependency key scheme (`tier-identity:` / `structure-identity:` / `structure-touched:` + `aspects/<id>/` prefix + references) is now centralized in one place (`yggPrefixOf` + the key-builders in `core/graph/files.ts`) so the producers and the two consumers cannot drift apart.
- `deterministic` aspects carry no per-aspect `language:` declaration. The runner resolves each source file's grammar from its file extension via the language registry, so a per-aspect language list would be inert metadata that nothing in the runtime consumes — and could silently disagree with what was actually parsed. Any legacy `language:` key found in an aspect file is silently ignored (a later migration strips it). The language registry (`core/graph/language-registry.ts`) is the single source of truth for extension→grammar: `ast/parser.ts` and the runner's extension check both resolve through `getGrammarForExtension` / `getLanguageForExtension` instead of hardcoded duplicates. A file whose extension has no registered grammar yields no parsed tree (rather than a per-aspect error). The deterministic-aspect drift identity is held stable across this change, so existing approvals are not invalidated.
- Node-size gate is now a per-node **character budget** enforced as a blocking error, replacing the previous file-count `wide-node` warning. `yg check` emits `oversized-node` (error) when a node's reviewer context — the total characters of its mapped source files plus the distinct reference files of its effective aspects — exceeds `quality.max_node_chars` (default 40000). The metric is uniform across all node types (it no longer depends on aspect presence), so granularity is enforced even on nodes with no LLM aspect. Binary files (by extension or NUL-byte content) contribute 0; a file over the 5 MB content-scan limit is counted by its on-disk size so it cannot evade the gate. Rationale: the reviewer concatenates all of a node's files into each aspect prompt, so an oversized node risks context-window truncation that deterministically rejects unchanged code — a file-count limit missed this because one very large file could stay under the count. `quality.max_node_chars` is validated as a positive integer.
- Internal: the aspect-cascade engine (`core/graph/aspects.ts`) now walks the six attachment channels (own, ancestor-node, own-type, ancestor-type, flow, port) in a single `iterateAttachments` generator. `computeEffectiveAspects`, `computeEffectiveAspectStatuses`, `getAspectSource`, and `getAspectStatusSources` reduce over it instead of each re-walking the channels, eliminating the duplicated traversal (446→351 lines) while preserving each function's distinct `when`-policy, aggregation, and origin formatting. Behavior is unchanged — locked by a characterization snapshot covering every channel plus implies, predicate filtering, status overrides, and the via-parent flow case.
- Internal: `core/validator.ts` (the 2121-line / ~83k-char validation god-file) split into a thin `validate()` orchestrator plus domain-grouped check modules under `core/checks/` (`architecture.ts`, `aspects.ts`, `aspect-contracts.ts`, `mapping.ts`, `relations.ts`, and a shared `shared.ts` holding `issueMsg`). Verbatim function moves — no change to which checks run, their order, their messages, or their verdicts. Reduces the largest engine file so the reviewer can inspect it without context-window truncation.
- Internal: drift-layer classification — deciding whether a changed file is a direct source edit or an upstream cascade — is now a single shared `buildLayerResolver` helper in `core/graph/files.ts`, consumed by both `core/check.ts` (`classifyDrift`) and `core/approve.ts` (`approveNode`). Both call sites previously carried near-identical inline lookups that had diverged in how they resolved a file reached through a directory mapping (check expanded the directory into a prefix match; approve relied on a downstream fallback). The unified resolver expands directory mappings via prefix match, prefers an exact-path match, and is first-writer-wins — behavior is preserved and locked by a new `files-layer-resolver` characterization test. A disagreement between the two paths could otherwise mislabel an edit, skipping a required re-review or forcing an unnecessary one.
- Structure-aspect runtime now shares one check.mjs export-shape validator and one mapping-path normalizer with the AST runtime, so malformed structure check.mjs files surface the same what/why/next guidance and the structure file-access gate and violation-context check normalize paths identically. `validateCheckModuleExport` and `normalizeMappingPath` live in `src/utils/`; both runners delegate their four export-shape guards to the shared validator (error codes unchanged), and the structure fs-gate (`ctx-fs`), the violation file-in-context check (`runner`), and `io/paths.normalizeMappingPaths` all route through the single normalizer (strip `./` + trim). This removes a latent `STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT` mismatch where a violation path beginning with `./` passed the fs-gate but failed the context check. `StructureRunnerError` now carries the structured `IssueMessage` (what/why/next) like `AstRunnerError`, surfaced at the approve boundary.
- `command` node type gains permission to depend on the new `test-suite` organizational type. Required for the new `sibling-test-file` aspect's cross-node lookup.
- New `structure-adapter` node type added (mirrors `ast-adapter`) covering `source/cli/src/structure/*.ts`.
- New `test-suite` organizational node type added — labels the test directory tree explicitly so commands can declare `uses: <test-suite>` without granting them dependency on every internal module.
- `yg check` output redesigned for agent-friendly terseness: the verbose multi-line header (with per-type node breakdown) is replaced by a single-line verdict + metrics header (`yg check: PASS/FAIL  N nodes · X/Y files · M aspects · K flows · D draft`). Cascade-drift errors with a shared upstream cause are grouped into one block with a `cascade (N)` label and a `→ {node list}` line instead of repeating 8-line what/why/next per affected node. The `Result: PASS/FAIL (0 errors, 0 warnings)` footer is eliminated — verdict is in the header. The `N draft aspects (skipped)` footer tally is absorbed into the header as `· D draft`. The `Next:` line is now a single actionable command (first line of `suggestedNext`, without annotation). `draftSkipped` now counts UNIQUE draft aspect IDs (not node×aspect pairs). `advisoryWarnings` footer tally removed.
- `AspectDef.reviewer` changed from optional `'ast' | 'llm' | undefined` to required `AspectReviewerSpec` (`{ type: 'llm' | 'deterministic'; tier?: string }`). All comparison sites updated from string equality to `.type` property access.
- `YggConfig.llm: LlmConfig | undefined` renamed to `YggConfig.reviewer: ReviewerConfig | undefined`. `ReviewerConfig` holds `{ tiers: Record<string, LlmConfig>; default?: string }` for named-tier support. `config-parser.ts` wraps the parsed `LlmConfig` in a bridge `tiers` map for v5 compatibility.
- `context-builder.ts`: all graph-derived paths written to output structures (`buildHierarchyLayer`, `buildStructuralRelationLayer`, `buildEventRelationLayer`, `buildNodeContextData`, `buildFileContextData`) now apply POSIX normalization via a shared `normPath` helper. Previously only caller-supplied `nodePath`, `filePath`, and `ownerPath` were normalized at the input boundary.
- `@chrisdudek/yg/ast` API surface reduced to raw tree-sitter primitives: `{ walk, report, inFile, findComments, closest }`. `walk(node, visitor)` replaces `within(parent, type, opts)`; visitor returning `false` skips descent. `closest(node, types)` retained as minimal-API ancestor lookup.
- `inFile` signature changed from string-with-heuristic to discriminated object `{ glob | regex | contains }`.
- `report(file, node, message)` now includes `column` field (0-based from `node.startPosition.column`).
- `AspectViolation.providerError: boolean` and `AspectResponse.providerError: boolean` refactored to required `errorSource: 'codeViolation' | 'provider' | 'astRuntime'`. AST runtime exceptions now flow through `errorSource: 'astRuntime'`.
- All 14 `deterministic` aspects rewritten against raw tree-sitter API: `atomic-write-contract`, `command-contract-shape`, `command-error-via-buildissuemessage`, `command-exit-codes`, `migration-bumps-version`, `no-direct-console`, `no-direct-fs`, `no-nondeterminism-direct`, `no-side-effects-on-import`, `parser-yaml-guard`, `posix-paths-source`, `provider-redaction`, `read-or-default-via-helper`, `single-source-graph-queries`.
- README "What Yggdrasil does" section reframed from "reviewer catches what the agent skipped" to "graph is the architecture spec, agent reads relevant aspects before editing, reviewer verifies after". Adds the pre-edit `yg context` step to the loop diagram, surfaces nodes/aspects/flows/ports vocabulary up front, and adds a paragraph on `log.md` as cross-session memory.
- Deduplicated `collectAncestors` in `core/effective-aspects.ts` — removed the leaf-first duplicate; the file now imports the canonical root-first implementation from `core/context-builder.ts`. Removes a bug-in-waiting where future callers could silently reverse traversal order by importing the wrong helper.
- Extracted shared `parsePredicateBoolean` helper into `core/parsing/predicate-boolean.ts`. Both `when-parser` and `file-when-parser` now delegate the `all_of`/`any_of`/`not` parsing to it — eliminates ~50 LOC of identical logic. The helper accepts an optional error class so `file-when-parser` preserves its `WhenPredicateInvalidError` contract.
- Added `io/read-or-default.ts` — small helper that wraps `readFile` with ENOENT-only handling (returns the supplied default on missing file, rethrows other errors). `log-store.readLogSafe` migrated to use it. Persistence-adapter type's `when` predicate extended to claim the new file.
- **BREAKING:** `yg-config.yaml` reviewer format. The legacy single-section shape (provider keys directly under `reviewer:` + `reviewer.active`) is no longer accepted at parse time — the parser raises `config-reviewer-legacy-format` with a migration hint. Use named tiers under `reviewer.tiers` instead. Run `yg init --upgrade` to migrate.
- **BREAKING:** `yg-aspect.yaml` reviewer field. The string shorthand (`reviewer: llm` / `reviewer: ast`) is rejected with `aspect-reviewer-legacy-string`. Required format: `reviewer: { type: llm | deterministic }` with optional `tier:` (LLM aspects only). `yg init --upgrade` migrates a legacy `reviewer: ast` to `{ type: deterministic }`.
- **BREAKING:** the per-node canonical drift hash now includes a `tier-identity:<aspectId>` synthetic entry per LLM aspect. After running the v5 migration on a previously approved repository, every previously-approved node enters drift on the first `yg check`. Re-approve once per node, or use batch `yg approve --aspect <id>` to fold the bulk re-approve into the upgrade PR.
- `DEFAULT_CONFIG` template version bumped to `5.0.0`.

### Fixed

- **A corrupt or outdated drift-state baseline now reports as a recoverable state problem, not an internal CLI bug.** When a baseline file (`.yggdrasil/.drift-state/<node>.json`) is hand-edited, written by incompatible tooling, or predates the typed format, the CLI previously surfaced the failure through the generic unclassified-error path — prefixed "Unexpected error while …" and suffixed "This is a bug — please file an issue." A malformed baseline is an expected, recoverable state condition with concrete next steps, so it is now rendered directly as a what/why/next message and exits 1 (fail-closed) without the bug-report framing. This is handled centrally, so every command that reads baselines (`check`, `approve`, and the rest) is consistent.
- **The corrupt-baseline recovery commands now name the real node.** The restore-or-delete advice for a current-version-but-corrupt baseline interpolated a literal `${nodePath}` placeholder into its `git checkout` and `yg approve` commands, making them un-runnable; they now substitute the actual node path so the suggested commands are copy-pasteable.
- **The canonical drift hash is now locale-independent.** The file-digest that feeds a baseline's canonical hash was ordered with `localeCompare`, a locale-aware comparison whose result can depend on the host's runtime locale — so two machines with different locales could compute different baseline hashes for identical code and report spurious cross-environment drift. The digest now orders with a code-unit (`.sort()`) comparison, matching how the hash's typed-identity half was already serialized, so both halves are ordered consistently and the hash is stable across environments. The two non-canonical digests in the same module (`hashPath`, `hashForMapping`) were aligned to the same code-unit ordering to remove the latent trap. The produced hash value is unchanged for existing baselines (code-unit and locale order coincide for real repo-relative paths), so no re-approval or migration is required.
- The LLM reviewer prompt now **escapes adopter-controlled source content and node/aspect metadata** before interpolating them into its XML framing, matching the references block (which was already escaped). Previously a source file containing `</file>` or `<…>` markup — or node/aspect attributes containing quotes/angle brackets — could break out of the `<file>`/`<node>`/`<aspect>` framing or inject markup into the prompt. File bodies and paths and the node/aspect attributes are now run through `escapeXmlText`; the aspect *rule body* stays raw (it is the trusted instruction the reviewer must read verbatim). (Remediation finding F3.)
- The Google reviewer provider now sends its API key in the `x-goog-api-key` **header** instead of the `?key=` **URL query string**. A key in the URL leaks into proxy/CDN/server access logs and any error report that echoes the request URL; the header form (Google's supported alternative) keeps the credential out of the URL. A unit test captures the outgoing request and asserts the secret is in the header and absent from the URL. (Remediation finding F2.)
- `yg context --node <bad-path>` now reports a structured what/why/next instead of the generic "The CLI encountered an error it does not classify / This is a bug — please file an issue" crash. A typo'd node path is a user error, not an internal bug; the message now states the node does not exist, explains that `--node` must name an existing node directory under `model/` (without the prefix), and points to `yg tree` / `yg find` to locate a valid one. (Remediation finding G2.)
- `yg find` now prints **0–1 relevance scores** instead of raw, unbounded MiniSearch scores (e.g. `2.94`). The raw TF-IDF-style scores were query-dependent and uninterpretable, and contradicted the rules' documented 0–1 scale. Scores are now normalized relative to the best match — the top result is `1.00` and the rest are its fraction — so a large gap from #1 to #2 signals a confident winner and a tight cluster signals an ambiguous query. The agent-rules "find an entry point" guidance was corrected to describe this **relative** interpretation (and to drop the old absolute `>0.6 / 0.3–0.6 / <0.3` thresholds, which raw MiniSearch scores never supported) and regenerated. (Remediation finding G1.)
- The deterministic-aspect read sandbox (`ctx.fs` / `ctx.parsers`) now defends against **symlink escape**. `resolveAllowedReadPath` previously checked only the TEXTUAL path — rejecting `..` traversal and absolute paths and enforcing the allow-set — but never resolved symlinks, so an allowed directory that is a symlink pointing outside the repository (e.g. an allowed `src/lib` linked to `/etc`) let an untrusted `check.mjs` read arbitrary files through it. After the lexical checks, the resolver now `realpath`s the nearest existing ancestor of the target and requires it to remain within the realpath'd repo root (both sides canonicalized, since the project root itself may sit under a symlink such as `/tmp`→`/private/tmp`); a non-existent leaf has nothing to follow and is left to fail naturally. A within-repo symlink (pointing at an allowed file inside the repo) is still honored. (Remediation finding B5.)
- A deterministic-aspect node is now **fully settled by a single `yg approve`**, and a draft→advisory/enforced status flip is correctly re-recorded — a two-part fix for one root cause. (1) The per-aspect `check-touched:<id>` synthetic set-hash keys were folded into the baseline's `hash` but not its `files` map, so a node needed a *redundant second approve* to settle; until then, the first drift for any other reason dragged in spurious "the set of files read by deterministic aspect '<id>' changed" causes, and `yg approve --flow`/`--aspect` (which target cascade drift) *over-included source-only-drifted nodes*. The keys are now folded into `files` too (no change to the canonical hash → no migration, no drift on existing baselines). (2) Removing that wart exposed a masked bug: because aspect *status* is excluded from the canonical hash (for advisory↔enforced stability), a `draft`→`advisory`/`enforced` flip does not change the hash, so `yg approve`'s hash-based decision reported "No changes" and never recorded the newly-active aspect's verdict — leaving `aspect-newly-active` and `yg check` red forever (the spurious check-touched difference had been *accidentally* triggering the re-record). `yg approve` now detects effective non-draft aspects that lack a recorded verdict (mirroring `yg check`'s `aspect-newly-active` condition, tolerant of pre-5.x legacy baselines) and re-approves so the reviewer records the verdict. Net effects: one approve settles a node; advisory↔enforced flips are a clean no-op (the prior verdict carries forward, only render severity changes); `--flow`/`--aspect` selection is precise. (Found by dogfooding the cascade-cause E2E suite; full analysis in the dogfood report.)
- **Single source of truth for structural issue codes (B7).** The set of structural error codes — those that always block `yg check` regardless of drift — was hard-coded twice: once in the check engine that tallies the summary count, once in the command renderer that groups errors into sections. The two copies had silently diverged (the engine's was a stale subset), so the structural-error count in the summary could disagree with what was shown grouped under the "Structural" heading. Both now import one shared definition (`core/check-codes.ts`), so the tally and the grouping can never drift apart again.
- The bundled **example projects (`examples/passing`, `examples/failing`) now work on the 5.0.0 model.** They were written for the pre-5.0.0 architecture where a node type could own files without a `when` predicate; under 5.0.0 that is a `type-without-when-with-mapping` error, so `examples/passing` actually failed `yg check` (the demo meant to show a clean pass) and `examples/failing` failed for the wrong reason. The `service` type now declares a `when` in both demos, `examples/passing`'s `payments` baseline was refreshed, and `examples/failing` now fails only for its intended reason (the `requires-audit` violation, surfaced as "payments never approved" until you run `yg approve`).
- A reviewer **rejection no longer advances the log-freshness baseline** (remediation finding H2). That baseline records the entry that justified the last *successful* approve, and the mandatory-log gate compares a new source change against it. Because the per-aspect refused verdict is persisted on a rejection (so `yg check` can render the refusal without re-running the reviewer), the commit was also advancing the freshness baseline — which forced the author to write a brand-new log entry merely to *retry* after a rejection, contradicting the documented "one entry covers all source edits within a single approve cycle (including failed approves and retries) until approve succeeds." A refused commit now preserves the prior log baseline (or omits it when nothing has been approved yet) while still advancing the source hash and recording the refused verdict, so the gate stays red until a clean re-approve but the same entry keeps satisfying it across the fix-and-retry. The rules and `log-management` knowledge were reworded to say "last **successful** approve" and to state that a failed approve advances nothing; `DriftNodeState.log`'s contract already documented this. Regression tests cover both the no-prior-baseline (dropped) and prior-success (preserved) branches.
- The reviewer now **fails closed** on an infrastructure failure instead of recording a false-green over unverified code (release blocker). Previously, when an LLM aspect could not actually be verified — the provider was unreachable, returned a non-200 or an unparseable response, or **no reviewer was configured for an effective non-draft LLM aspect** — `yg approve` still committed a baseline (advancing the hash and carrying the prior `approved` verdict forward), so the next `yg check` went green over code the reviewer never saw. The commit phase now advances the baseline **only on a run with zero infrastructure dispositions**: any infra failure ends the run red (`exit 1`) and writes **nothing** to drift-state — the prior baseline is left fully intact and the drift stays visible until a clean approve. The decision is computed locally at each terminal branch, so an early-return path (tier-resolution failure, AST/structure short-circuit, reference-load failure, check-runtime crash, mid-tier provider-unavailable, no-reviewer-for-LLM-aspect) cannot bypass the guard. A pure enforced code refusal is unchanged — it still commits a `refused` verdict and is red via the verdict. Additionally (**A3b**), an **unparseable** reviewer reply is no longer guessed at with a natural-language heuristic: a garbled response that merely contains the word signalling approval previously became a code PASS; it is now classified as a provider (infrastructure) error and fails closed. The CLI's `unavailable` notice and the `rules.ts` / `drift-and-cascade` knowledge were corrected to document the fail-closed outcome (no baseline recorded) and the no-reviewer-for-LLM-aspect = red rule; rules regenerated. Driven by a new hermetic suite `cli-fail-closed-mock` (provider-500 and garbled-response on a source change leave the baseline unadvanced and `yg check` red; a clean approve still commits). The tier-cascade, lifecycle, deterministic-lifecycle, and reference-file-cascade E2E suites that previously leaned on the false-green (a dead reviewer still writing a baseline) were migrated to the live in-process mock.
- Reviewer-response JSON extraction no longer false-negatives on a verdict wrapped in brace-bearing prose. A verbose reviewer (e.g. Claude Code / Sonnet) may precede its `{"satisfied": …}` verdict with markdown analysis and code snippets that themselves contain brace characters; the old greedy `\{[\s\S]*\}` match spanned from the first prose brace to the last brace, producing invalid JSON that — under the new fail-closed rule — would wrongly burn the node as an infrastructure failure. `parseAspectResponse` now scans for the balanced `{…}` object that actually carries a boolean `satisfied` field (taking the last such object), so a real verdict is recovered wherever it sits in the prose, while a brace-laden reply with no real verdict still yields nothing and fails closed. (Surfaced by dogfooding the fail-closed change against the repo's own Sonnet reviewer.)
- `runDryRunForNode`'s reference-load-failure warning now uses the structured `buildIssueMessage` what/why/next format like every other agent-visible diagnostic, instead of an ad-hoc `(warning: …)` string. It is a context-build failure with a concrete remediation path, so it states which reference failed, that the previewed prompt will not match a real run until it loads, and how to fix it. (Found by the repo's own `what-why-next` reviewer during the fail-closed dogfood reconcile.)
- The tree-sitter WASM grammars now actually work in a published install (release blocker). Two compounding defects meant a `npm install`ed copy could never parse: (1) `tsup` copied the grammars to `dist/grammars/<lang>.wasm` but the parser resolves them by their registry name `tree-sitter-<lang>.wasm`, and `package.json` `files` did not include `dist/**/*.wasm` at all — so the grammars were both mis-named and excluded from the tarball; (2) the parser's grammar directory resolved to `<pkg>/grammars` (via `../grammars` from the flat-bundled `dist/bin.js`) instead of `dist/grammars`, so even a correctly-named, shipped grammar was looked for in the wrong place and fell through to the dev-only `tree-sitter-*` devDependency (absent in a real install → `Cannot find module`). Locally everything passed because the unit/e2e tests run from source and always hit the devDependency fallback, so the production `dist/grammars` path was never exercised. Fixes: copy under `tree-sitter-<lang>.wasm`, add `dist/**/*.wasm` to `files`, resolve the grammar dir as `__dirname/grammars` (with `../grammars` kept as a fallback), and wrap the devDependency fallback so its absence yields a clean "could not find WASM grammar" error. A new **pack-and-smoke gate** (`scripts/pack-smoke.mjs`, wired into `repo-check.sh`) packs the tarball, installs production deps only, and runs a parse-requiring command — so a missing/renamed/excluded grammar fails the gate, not the user. (Found and proven by the new pack-smoke; this is the only check that exercises the published grammar path.)
- `impact-graph.ts` no longer sorts its impacted-component list with a locale-aware `localeCompare`, which depends on the runtime's default locale (implicit environment state) and could order the same graph differently across machines. It now uses a deterministic code-unit comparison, consistent with every other sort in the module. (Caught by the architecture reviewer enforcing the engine's own determinism rule.)
- A bare advisory↔enforced status flip no longer cascades. The drift tracker hashed the entire `aspects/<id>/yg-aspect.yaml` (status line included) into each node's canonical drift hash, so flipping a rule's status — content and source unchanged — changed the hash and reported `cascade aspect '<id>' changed` on every node using it, contrary to the documented contract ("status is not part of the canonical drift hash; it stays stable across advisory↔enforced flips"). `core/graph/files.ts` now tracks a status-stripped `aspect-meta:<id>` synthetic (the aspect's definition metadata minus `status`) instead of the raw file, so a status flip keeps the canonical hash stable and does not cascade; the verdict carries forward and only the render severity changes. A draft↔non-draft transition is still surfaced (via `aspect-newly-active`); a genuine definition change still cascades and is attributed to its aspect (`describeCascadeCause` reads "the definition of aspect '<id>' changed"; `selectDriftedAspects`/`filterAspectCascadeNodes` recognise the `aspect-meta:<id>` cause so re-verification re-runs only that aspect). (Found by the comprehensive E2E sweep.)
- A node whose every effective aspect is in the `draft` phase no longer bypasses the mandatory-log gate. `yg approve` short-circuited the all-draft case with `exit(0)` BEFORE invoking the core approve algorithm, so the log gate inside the core's all-draft branch was unreachable — an all-draft `log_required` node could have its source changed and be silently approved with no justification entry. The command now runs the core all-draft branch (which enforces the gate), honors its refusal, and emits the all-draft notice only on a clean pass. The log requirement is independent of aspect status, as documented. (Found by the comprehensive E2E sweep.)
- A `draft` (dormant) implier no longer drags its implied aspect into force. `computeEffectiveAspectStatuses` already skipped draft impliers, but `computeEffectiveAspects` (the id set, via `expandImpliesFiltered`) walked the implies graph applying only `when` filters and never consulted the implier's status — so a draft implier still pulled its implied aspect into the effective set, where it fell back to its own default (enforced) and blocked approve. The set computation now gates implies-traversal on the implier's effective status, matching the status computation; an implied aspect still applies whenever reached via any non-draft channel. (Found by the comprehensive E2E sweep.)
- `parseLog` (the per-node history reader) is now CommonMark-fence aware, matching `validateFormat`. A `## [<datetime>]` line inside a fenced code block in an entry body was treated as an entry header by the reader (but correctly as body by the validator), so a history that validated as N entries could be read back as N+1 — e.g. an entry quoting a header-shaped example. Both now agree on entry boundaries. (Found by the comprehensive E2E sweep.)
- `yg check` cascade-cause messages now name the actual cause for three synthetic tracked-file keys that previously rendered an unhelpful placeholder: a node's own-definition change (`own-subset:<node>`) now reads `node '<node>' own metadata changed` instead of `parent node 'unknown' metadata changed`; a dependency's port-aspect change (`port-aspects:<target>`) now reads `dependency '<target>' port aspects changed` instead of `dependency 'unknown'  changed`; and a cross-node file read by a deterministic aspect's check (the `check-touched` layer) now reads `a file read by a deterministic aspect changed` instead of the generic `tracked file changed`. (Found by the comprehensive E2E sweep.)
- `yg check` no longer crashes with an unclassified "please file an issue" error when an `implies` cycle exists and an affected node already has an approved baseline. The drift pass computed effective aspects (expanding `implies`) and threw on the cycle before the validator's structured `aspect-implies-cycle` issue could render — so the same cycle reported cleanly without a baseline but crashed with one. The cycle signal is now a dedicated `ImpliesCycleError`, and `classifyDrift` skips a node whose effective-aspect computation hits a cycle (the validator, run first, already reports it as a blocking error), so the structured `aspect-implies-cycle` message surfaces in both cases. (Found by the new E2E implies suite.)
- Parsers for node/type/target reference arrays now fail loud on a non-string entry instead of silently dropping it. `flow` participant lists, node-type `parents`, relation `targets`, and a relation's `consumes` (port names) previously used a `typeof === 'string'` filter that quietly discarded any non-string entry — so a malformed flow participant vanished and escaped aspect enforcement. Each now throws a blocking validation error naming the field, the offending value, and its index.
- Drift documentation corrected for flows: a flow influences a participant's drift only by changing the participant's effective aspects (adding/removing a flow aspect, or adding/removing a participant) — a cosmetic edit to the flow file (e.g. its `description:`) does not cascade. The agent rules and the `drift-and-cascade` knowledge topic previously implied any flow-file edit cascades; the behaviour is unchanged (the docs were inaccurate).
- `yg check` cascade rendering no longer emits a doubled slash when collapsing multiple sibling nodes under a common prefix. `formatNodeList` trimmed the longest common prefix back to the last directory boundary but, when that prefix already ended in `/`, re-appended a second separator — producing `services//{orders, payments}` instead of `services/{orders, payments}`. The trim now strips the trailing slash before regrouping, so the compact form always shows exactly one separator.
- A `yg-config.yaml` schema version newer than the CLI supports is now reported as a clean user error instead of being wrapped as an internal bug. `graph-loader` throws a recognizable `UnsupportedSchemaVersionError`, and `loadGraphOrAbort` detects it and emits a structured what/why/next message (config schema X is newer than this CLI's max Y; this CLI cannot safely read a newer graph; upgrade the yg CLI) before exiting 1 — without the "This is a bug — please file an issue" wrapper from the generic unexpected-error path. Every command that loads the graph via `loadGraphOrAbort` (including `yg check` and `yg tree`) gets the clean message.
- `yg check` now surfaces the `mapping-path-missing` validation error properly — its code and the offending node path, with the what/why/next message. Previously it was mis-grouped with the coverage (`unmapped-files`) summary and rendered as a bare `unmapped (0)` line with no code and no node path, so an agent could not tell which node mapped a missing file. (Found by the new E2E validation-matrix suite.)
- `yg init --upgrade --platform <name>` (the non-interactive path agents and CI use) no longer reports false success when a migration is withheld. The runner now exposes a `withheld` signal (a migration returned `bumpVersion: false`, stopping the chain before the latest target); the flag path exits 1 with the warnings and the fix-and-re-run guidance when an upgrade is incomplete, and surfaces (rather than swallows) informational warnings on a completed upgrade. Previously it always printed "Rules and schemas refreshed" and exited 0, hiding a withheld bump. The no-mutation safety was already correct; only the missing signal is added. (Found by the new E2E migrations suite.)
- Documentation–implementation consistency pass (knowledge topics + schemas): removed retired "AST/structure aspect" and "structure runner" vocabulary left over from the reviewer-type collapse (`writing-llm-aspects`, `drift-and-cascade`, `schemas/yg-aspect.yaml`); documented the two previously-undocumented blocking port error codes (`port-undefined`, `port-missing-aspect`) in `ports-and-relations`; documented the `check-touched:<id>` per-node drift key alongside `tier-identity:` in `drift-and-cascade`; completed the `cli-reference` command summary (was missing `owner`/`deterministic-test`/`type-suggest`/`init`); corrected `conditional-aspects` to attribute `has_mapping` only to the `node` `when`-atom; and fixed a deterministic-aspect cookbook comment that mischaracterized when `ctx.graph.node` throws.
- `yg approve --dry-run` is now rejected (exit 1, structured message) when combined with `--aspect` or `--flow`. Previously the dry-run guard only checked `--node`, so a batch dry-run silently fell through and performed a **real**, baseline-writing approval — a destructive action when the user expected a preview.
- `yg approve --aspect <id>` now includes nodes that drifted only because a cross-node file read by one of the aspect's graph-aware `deterministic` checks changed. `filterAspectCascadeNodes` reads each candidate node's baseline and attributes such cross-node paths to the aspect (via `checkTouchedFiles`), mirroring `selectDriftedAspects`; previously those nodes were silently excluded from the batch, forcing a `--node` fallback.
- Batch approve no longer aborts and discards all results when one worker throws an unexpected exception. Each node's work is isolated: an unexpected throw is recorded as that node's failure and the remaining nodes still run, honoring the documented "one node's failure does not abort the others" contract.
- `yg approve` no longer crashes with a `TypeError` on a corrupt/hand-edited baseline missing its `files` map. A missing map is treated uniformly as a cold start (all current files re-verified) at every access site.
- `yg tree --depth <n>` now rejects non-numeric or negative values with a clear argument error. Previously an unparseable value became `NaN`, which silently disabled the depth limit and printed the entire tree with no signal.
- `yg approve` now POSIX-normalizes file paths in its debug-log output (`loadSourceFiles` skipped-file notice, `snapshotLog` ENOENT notice), matching the already-normalized return values — so debug output is consistent with the rest of the path-output contract on backslash hosts.
- A node no longer triggers a full LLM re-review when it drifts only because a cross-node file read by one of its graph-aware `deterministic` aspects changed. `selectDriftedAspects` now attributes such a change (tracked on the `check-touched` layer as the related node's actual path) to the owning deterministic aspect via the node baseline's `checkTouchedFiles`, so only that local, zero-cost check re-runs and every LLM verdict is carried forward. Previously the raw cross-node path was un-attributable, forcing a node-global re-run of every effective LLM aspect — costly and non-deterministic (re-reviews flaked and had to be retried). `aspectDependencyKeys` gained an optional `checkTouchedFiles` argument threaded only through `selectDriftedAspects`; `filterAspectCascadeNodes` (the `--aspect` selector) is unchanged. Cascade messages for the synthetic `check-touched:<id>` and `tier-identity:<id>` causes now name the owning aspect ("the set of files read by deterministic aspect '<id>'" / "the resolved reviewer tier for aspect '<id>'") instead of "declared by unknown aspect".
- The drift report now POSIX-normalizes deleted-file paths in `classifyDrift` (`core/check.ts`). The deleted-files loop computed a normalized path but emitted the raw stored key (which may carry host backslash separators) into the agent-visible "deleted" and cascade-cause output; on a backslash host this leaked non-POSIX paths into the report. Every classification lookup and output string in the loop now uses the normalized path.
- **Internal rename (no behavior change):** the persisted-state tokens that referenced the retired `structure`/`ast` reviewer kinds are renamed to `check`-prefixed names (after the `check.mjs` artifact they track) — `structureTouchedFiles` → `checkTouchedFiles`, the `structureTouchedKey`/`structure-touched:<id>` synthetic drift key → `checkTouchedKey`/`check-touched:<id>`, the `TrackedFileLayer` value `'structure-touched'` → `'check-touched'`, and the `AspectVerdict.errorSource` value `'astRuntime'` → `'checkRuntime'`. These never shipped in a released version (5.0.0-only), so no migration is needed for 4.x adopters; in-repo baselines were migrated in place.
- `yg approve` diagnostics for the reviewer-unavailable notice and the advisory-violation summary now derive from structured `what`/`why`/`next` data via `buildIssueMessage`, matching every other agent-visible message in the command. The reviewer-unreachable notice previously had no actionable next step, and the advisory-violation header/labels were hardcoded strings; both flowed against the `what-why-next` contract. Per-violation reviewer assessment text (the LLM's own `reason`) is preserved verbatim, as it is exempt from the structured-message rule.
- Structure reviewer now honors `yg-suppress` markers. A violation on a source line waived by a `yg-suppress(<aspect-id>)` comment (or a `*` wildcard / bracket `disable`–`enable` range) for the matching aspect is filtered out before the verdict is recorded — matching the AST reviewer, which already respected these waivers. Previously the structure runner ignored suppress comments entirely, so the same documented waiver behaved differently depending on whether the rule was implemented as an AST (single-file) or structure (graph-aware) check. The fix reuses the existing `ast/suppress.ts` module unchanged: `runStructureAspect` builds per-file suppressed ranges from the eagerly-parsed `astCache` and filters violations by `(file, line, aspectId)`. Graph-level violations (no `file`/`line`) and violations in files with no parsed tree remain non-suppressible by design. Closes the deferred structure-suppress gap (STRUCT-1).
- Drift classification is now prefix-aware for directory mappings. A reference file (or structure-touched path) that sits UNDER a node's directory mapping is recognized as source-owned, not misclassified as upstream drift. Previously the ownership guard used exact-set membership, so a reference under a directory mapping was tracked as an upstream cascade — which let an own-file edit bypass the source-drift log requirement. Both the aspect-reference and structure-touched guards in `core/graph/files.ts` now share one `isOwnedByMapping` helper (`path === entry || path.startsWith(entry + '/')`).
- `yg approve` now normalizes paths to POSIX form at every output boundary in `core/approve.ts`. `loadSourceFiles` (the source files handed to the reviewer and the dry-run prompt) and `sourceFilesChanged` (the changed-file list shown in the mandatory-log refusal message) returned paths carrying whatever separators the underlying hash map held, while the neighbouring `classifyChangedFile` already normalized. On a host whose native separator is the backslash this could surface backslash paths and trailing slashes in the dry-run prompt and the refusal message; all three boundaries now apply `\`→`/` and trailing-slash stripping uniformly, so the cross-platform output contract holds regardless of which function emits the path.
- `yg approve` (full-node): a per-aspect verdict that the reviewer could not validly evaluate this run — an infrastructure failure (provider timeout/crash, runner crash, unreadable reference file; `errorSource !== 'codeViolation'`) or an aspect with no reviewer result at all — no longer wipes that aspect's prior good baseline verdict. `buildAspectVerdicts` now reports such aspects in a `carryForward` set, and the full-node branch of `applyAspectVerdictsToResult` reinstates their prior verdict instead of dropping them. Previously a full-node approve rebuilt the verdict set from only the aspects actually evaluated, so a transient infra failure on one aspect erased its last known-good verdict and the next `yg check` flagged it as `aspect-newly-active` (a CI-blocking error) on a non-code event. Carry-forward reinstates only aspects that remain effective; an aspect no longer effective on the node is still dropped. The filtered (`--aspect`) and reviewer-aborted paths are unchanged.
- CLI reviewer providers (`claude-code` and any `CliAgentProvider` subclass): the subprocess now drains `stderr` and the default subprocess timeout is raised from 120s to 300s. Previously the spawn read `stdout` but left `stderr` piped-and-unread; a reviewer child that wrote more than the ~64KB pipe buffer to stderr would block on its write and never exit, presenting as a spurious timeout / "Reviewer unavailable" on large prompts. Separately, a large node's per-aspect prompt (many source files plus references) can legitimately take ~100–300s through a CLI provider, so the 120s default intermittently timed out big-node reviews on otherwise-correct code. The timeout remains tunable via `reviewer.timeout`; keeping nodes small is the durable fix, this default just removes the boundary flakiness. The timeout-kill debug log now includes the tail of captured stderr for diagnosis.
- LLM tier identity (drift detection): `reviewer.timeout` is now excluded from the canonical tier-identity hash, alongside the already-excluded `api_key`. `timeout` is an operational knob (how long to wait for the subprocess) that does not change the reviewer's judgment, so tuning it must not invalidate baselines. Previously, including it meant adjusting the timeout in `yg-config.yaml` cascaded synthetic `tier-identity:<aspectId>` drift across every node using that tier. Because `canonicalJson` omits `undefined` keys, removing `timeout` from the hash does not itself cause a one-time cascade for configs that never set it.
- `yg init --upgrade` (v4→v5 migration): when the legacy `yg-config.yaml` contains `reviewer.consensus` set to an even, zero, or non-integer value (legal in v4, never constrained), the migration now pushes a descriptive warning and withholds the config write and version bump. Previously the migration silently copied the invalid value into every tier, producing a v5 config that the parser rejects on load; because no warning was emitted the version was bumped and the migration could not re-run — leaving the user with a dead recovery path requiring a hand-edit. The fix follows the existing "warning prevents migration" convention: an odd or absent `reviewer.consensus` migrates normally; an invalid value names the field, the bad value, and the corrective action ("Set an odd value and re-run `yg init --upgrade`").
- Structure runner: `ctx.parseAst` called on a file that was not pre-warmed by the dispatcher now surfaces as a typed `structure-aspect-parseast-not-prewarmed` violation (with `succeeded: false`) instead of falling through to the generic `STRUCTURE_CHECK_THROWN` hard runner error. Implemented by introducing a `ParseAstNotPrewarmedError` custom error class (exported from `ctx-parsers.ts`); the runner's catch block detects it via `instanceof` and converts it to a violation, mirroring the existing `UndeclaredFsReadError` / `UndeclaredGraphReadError` guard pattern.
- `buildAspectVerdicts` no longer persists `verdict: 'refused'` for infrastructure errors (`errorSource !== 'codeViolation'`: provider unreachable, AST/structure runner crash, unreadable reference). Previously, any unsatisfied aspect result was recorded as `refused` regardless of cause, turning a transient infra failure into a durable CI-blocking verdict in the baseline. The fix skips recording a verdict for infra errors so the prior baseline verdict is carried forward by `applyAspectVerdictsToResult` — mirroring the existing `reviewerAborted` philosophy. Only genuine code violations (`errorSource: 'codeViolation'`) are still recorded as `refused`.
- **BEHAVIOR CHANGE:** `config.timeout` in `yg-config.yaml` is now interpreted in **seconds** (the documented unit). Previously the raw number was passed through as milliseconds. A user who had set `timeout: 120000` expecting 120 seconds will now get a 120000-second timeout; the correct value is `timeout: 120`. The default of 120 seconds (120 000 ms internally) is unchanged. The `yg-config.yaml` schema template now includes a commented `timeout` example documenting the seconds unit.
- `yg approve` mandatory log-entry requirement is now decoupled from aspect status. A fresh log entry is required if and only if the node type has `log_required: true` (the default) AND the node's source files changed since the last approve (with the entry newer than the one captured at the last approve). Three couplings were removed: (a) a node whose every effective aspect is `draft` no longer skips the log requirement — the all-draft path skips only the reviewer, not the log gate; (b) a node with no `mapping:` now honors `log_required` — a `log_required: false` type's mapping-less node is a clean no-op instead of unconditionally demanding a `log.md`; (c) a node first approved without a log baseline is re-blocked when its source later changes (the mandatory check no longer requires a prior `storedEntry.log`; that guard is retained only on the append-only integrity check, which correctly applies only when a prior log baseline exists). The "Log requirement and aspect status" block was removed from the log-management knowledge doc, and `rules.ts` / drift-and-cascade wording now states the log-required + source-change model explicitly and its independence from aspect status.
- `yg approve` no longer fails on a code violation of an `advisory`-status aspect. Previously any non-draft code violation produced a red "Reviewer found aspect violations" refusal and exit 1 regardless of status, contradicting advisory's "warns, does not block" semantics. Now `approve-reviewer.ts` partitions code violations (`errorSource: 'codeViolation'`) by effective aspect status: an advisory-only set (zero enforced) preserves the approved-family action, records the baseline and per-aspect verdict as before, and surfaces the violations on `LlmApproveResult.advisoryViolations`. The CLI prints these as a cyan informational line (`ADVISORY (not blocking)`) instead of the red refusal and treats the node as passed for exit-code purposes (single → exit 0; batch/filtered → not counted as failed). The AST/structure short-circuit is likewise status-aware: an advisory AST/structure violation no longer refuses early and no longer blocks LLM dispatch. Only an enforced code violation (or a mix containing one) refuses with exit 1; reviewer infrastructure and reference-load failures still always block. `yg check` continues to render the recorded advisory verdict as a non-blocking warning. Documented in the aspect-status knowledge doc and `rules.ts` (regenerated `.yggdrasil/agent-rules.md`).
- Cross-node files read by a graph-aware `deterministic` aspect now participate in the dependent node's drift identity and `yg impact --file` blast radius. Such an aspect can read a related node's file cross-node (recorded in the baseline's `structureTouchedFiles`), but `collectTrackedFiles` only emits the `structure-touched` layer when passed the baseline — and no production drift call site did, so editing a cross-node-read file never drifted the dependent node and `yg impact --file` reported "0 nodes". The baseline is now passed at the drift sites (`check.ts`, the existing-baseline branch of `approve.ts`), and `approve-reviewer.ts` recomputes the canonical drift hash after the structure runner populates `structureTouchedFiles` so the cross-node files enter the node's drift identity on the first approve. Own-mapping paths stay on the `source` layer (own edits track as source drift); only genuinely cross-node paths get the `structure-touched` layer, and they are kept out of `state.files` so the deleted-file detector does not misreport them as phantom `(deleted)`. `yg impact --file` now scans the `structure-touched` layer (precise, post-approve) plus `collectAllowedReadsForAspect` (pessimistic, cold-start) and reports the dependent nodes under a dedicated structure-cascade section. Filtered approve (`yg approve --aspect X`) carries forward a non-targeted structure aspect's `structureTouchedFiles` so its touched files do not silently drop out of the node's drift identity.
- Refactor: extracted the pure graph blast-radius and reverse-dependency algorithms (`collectReverseDependents`, `buildTransitiveChains`, `collectIndirectDependents`) and the cross-node structure-cascade scan (`collectStructureCascade`) out of `cli/impact.ts` into a new `core/graph/impact-graph.ts`. Restores `cli → core` layering (graph traversal belongs in the side-effect-free graph-query layer, not the command file) and keeps `impact.ts` within the reviewer's per-file size budget — the command had grown past the LLM truncation threshold, dropping its trailing catch block out of the review prompt and triggering a spurious `diagnostic-logging` refusal. `yg impact` output is unchanged; iteration and sort order are preserved.
- Documentation consistency pass across the agent rules (`rules.ts`), the `yg knowledge` topics, the graph schemas, and the user docs. Reconciled facts that had drifted apart between these sources: the agent rules now state the two reviewer types (`llm` / `deterministic`) and note `check.mjs` backs every `deterministic` aspect; the LLM cost model is stated uniformly everywhere as one call per effective non-draft LLM aspect × tier consensus × prompt-chunk count (`deterministic` checks free); a missing port `consumes` contract is described as a blocking `port-missing-consumes` error rather than a warning, the non-existent "accept the gap" resolution path is removed, and `consumes-without-ports` is documented; `yg approve --aspect/--flow` is described as re-approving only cascade-drifted nodes; `yg find` as indexing nodes and aspects only (not flows); `yg aspects`/`yg flows` as custom line output (not YAML); the `config.timeout` schema default corrected to 300s and scoped to CLI providers; `yg init` documented as shipping an empty `node_types: {}` with commented examples; `core-concepts.md` corrected to reference `type-strict-orphan`/`type-strict-misplaced` (the non-existent `strict-coverage` code removed), to state relation types are architecture-enforced (not "descriptive"), and to include the per-node size budget; the AST `ctx.files` shape corrected to `{ path, content, ast }` with the not-yet-built per-language `ctx.language` dispatch removed from the docs; and a dedicated structure-reviewer section added to `docs/reviewers.md`. Content-only — no runtime behavior changed.
- `yg approve --flow <name>` now re-approves the flow's participant nodes that carry cascade drift. Previously it selected nodes by matching a cascade cause-file path against the `flows/<name>/` prefix, but a flow-attached aspect's change is recorded under the aspect's own directory (and flow files are not tracked), so `--flow` matched nothing and re-approved no node. It now selects nodes that participate in the flow (honoring descendant inclusion) and have upstream/cascade drift.
- `yg approve --aspect <id>` now also re-approves nodes that drifted only because the aspect's declared reference file — or its resolved reviewer-tier / structure identity — changed, not just nodes whose cascade cause sits literally under `aspects/<id>/`. The prefix-only match silently skipped reference-file and identity-key cascades.
- `findComments(file)` (from `@chrisdudek/yg/ast`) now works when passed a `ctx.files` element (`{ path, content, ast }`): it derives the language from the file's path extension. Previously the documented file form threw `AST_FINDCOMMENTS_UNKNOWN_LANGUAGE` because the file object carries no `language`. An unknown extension now raises a clear `AST_FINDCOMMENTS_NO_LANGUAGE`.
- `yg log merge-resolve` now verifies new entries by content (timestamp + body), in both directions: it rejects dropped, body-altered, AND fabricated entries. Previously it matched entries by timestamp only, so an altered body or an invented entry passed verification as long as timestamps lined up. A missing `log.md` now returns a structured what/why/next message instead of an unexpected-error abort.
- Port `consumes` contracts are now enforced on every relation type, including event relations (`emits` / `listens`). The contract validation previously exempted event relations while channel-6 aspect propagation did not, so an event relation to a port-bearing node could receive the port's required aspects without ever being required to declare which port it consumes. `port-missing-consumes` / `consumes-without-ports` / `port-undefined` now apply uniformly to all relation types.
- `yg init` now prefixes its non-interactive-terminal and missing-graph-version errors with `Error:`, matching the command error-output convention used by the rest of the command.
- Documented several already-implemented behaviors the reference omitted: the semantic `when` reference-integrity checks (`when-unknown-type` / `when-unknown-node` / `when-unknown-port`), the real `yg aspects` and `yg find` output fields, and the AST runtime guards `AST_CHECK_ASYNC` / `AST_CHECK_RETURN_SHAPE`.

### Removed

- **`eslint-plugin-boundaries` and `eslint-import-resolver-typescript` dev dependencies + their config.** The layer-import rules they were meant to enforce never actually fired — the import resolver would not map our `.js` import specifiers to their `.ts` sources under ESLint flat config (verified across plugin v5/v6 and resolver v3/v4 with multiple settings), so every cross-layer import passed silently. Rather than keep dead config that looks like enforcement, it was removed. Layer rules remain documented in `.yggdrasil/yg-architecture.yaml` and are kept legal structurally by where files are placed (the B4/B6 relocations).
- `quality.max_mapping_source_files` config key and the `wide-node` warning code — replaced by `quality.max_node_chars` and the `oversized-node` error (see Changed). Existing configs that still set `max_mapping_source_files` are tolerated (the key is ignored). New `yg-node.yaml` field `sizeExempt: { reason }` opts a node mapping a single unsplittable generated/binary artifact (lockfile, append-only changelog, image) out of the character budget; the justification is required.
- `@chrisdudek/yg/ast` helpers: `call`, `imports`, `exports`, `decoratorsOf`, `modifiersOf`, `jsxElements`, `casing`, `nameOf`, `within`. Replaced by direct tree-sitter API access via `walk(node, visitor)`. `closest` retained in minimal API.
- Old `inFile(file, string)` signature. Replaced by discriminated object.
- Graph nodes `cli/ast/helpers-syntactic` and `cli/ast/helpers-naming`.
- README: "Too heavy? Try AutoReview" sibling-tool section and the Yggdrasil/AutoReview comparison table. AutoReview is being deprecated and cross-links are being cut across the family.

### Deferred

- Per-invocation result cache for diamond-converging graph-aware `deterministic` aspects — defer until repo-scale dogfood demonstrates redundancy.
- Architecture layering continues to live in `.yggdrasil/yg-architecture.yaml` (the source of truth) and stays legal structurally via where files are placed — the relocations B4 (command-support helpers) and B6 (when-predicate parsers), the `mapping-escapes-repo` validator (B3), and the single structural-code source (B7) all landed. An attempt to *also* enforce the layer-import rules in the linter via `eslint-plugin-boundaries` was abandoned and removed (see Removed) — see `.temp/dogfood-report.md`.

### Known limitations

- Two graph-aware `deterministic` aspects on the same node with contradictory rules (e.g. "file X must exist" vs "file X must not exist") are not detected automatically — both refuse forever and the user must read both `check.mjs` files to diagnose. v6.1 will surface a `potential aspect conflict on <file>` meta-warning.

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
