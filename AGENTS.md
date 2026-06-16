# Agent Instructions — Yggdrasil Repository

You work on the Yggdrasil repository: an open-source CLI that provides continuous architecture enforcement for AI-assisted development. This repo both implements Yggdrasil and uses it on itself (dogfooding).

## Context — Where Things Live

| Path                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `source/cli/`           | Implementation — CLI code.                                                          |
| `.yggdrasil/model/cli/` | Graph — describes intended CLI architecture. Aspects enforce rules on source code.  |
| `docs/`                 | User docs — for adopters.                                                           |
| `.plans/`               | Agent working dir — design docs and implementation plans. **Ignore skill paths** (e.g. `docs/plans/`) — always use `<root>/.plans/YYYY-MM-DD-<topic>-design.md` and `.plans/YYYY-MM-DD-<topic>-plan.md`. Gitignored; not committed. |

## Product Scope

`rules.ts` and `agent-rules.md` are consumed by agents in ANY repository that adopts Yggdrasil — not just this one. When editing rules content, examples, or guidance: use domain-neutral examples (no Yggdrasil-specific types or commands). Think "what would help an agent working on an e-commerce app or a mobile game?" not "what would help an agent working on this CLI."

## Constraints

- Never edit generated rules files (e.g. `.yggdrasil/agent-rules.md`, `.cursor/rules/yggdrasil.mdc`). To change the rules content: edit `source/cli/src/templates/rules.ts` (content) or `source/cli/src/templates/platform.ts` (frontmatter), then build and regenerate: `node source/cli/dist/bin.js init --upgrade --platform claude-code`. **Always regenerate after changing rules.ts** — this repo dogfoods Yggdrasil, so stale rules mean the agent operating on this repo uses outdated instructions. `AGENTS.md` is hand-authored project context only — never inject the Yggdrasil rules block into it (only `claude-code` platform is used here; the rules reach the agent via `CLAUDE.md` → `@.yggdrasil/agent-rules.md`).
- **Ignore generated rules files** for understanding: `.yggdrasil/agent-rules.md`, `.cursor/rules/yggdrasil.mdc`, etc. are auto-generated output. Never read or search them. The source of truth for rules content is `source/cli/src/templates/rules.ts`.
- **Always reflect changes in corresponding documentation.** When modifying code behavior, algorithms, or data structures, identify and update all documentation that describes the changed behavior — `docs/` (user docs) and `.yggdrasil/` (graph metadata). Changes to behavior are not complete until every document describing that behavior is consistent.
- **NEVER run `yg init` from a subdirectory.** Always run from the repository root. Running from `source/cli/` or any subdirectory creates a new `.yggdrasil/` there or corrupts the project config. Use `node source/cli/dist/bin.js` for local builds, not `npx yg` (which may use a cached global version).

## Yggdrasil-derived local state lives under `.yggdrasil/`

All Yggdrasil-derived local/rebuildable state (caches, indexes, scratch state) MUST live under the `.yggdrasil/` directory — never at the repo root or elsewhere. Gitignore it within `.yggdrasil/` (it is rebuildable and must not be committed). Example: the relation-conformance symbol-index cache lives at `.yggdrasil/.symbols-cache/<lang>.json` and is gitignored. Do not scatter Yggdrasil state outside `.yggdrasil/` (no root-level `.yg-cache/` etc.). The committed graph (model/aspects/flows/schemas/lock) also lives here; keep derived state in dot-prefixed, gitignored subdirectories so it never mixes with the committed graph.

## Adding Support for a New Agent

To add a new platform (e.g. a new IDE or agent): add it to `source/cli/src/templates/platform.ts` — implement `installFor<Platform>` to write the rules file to the agent's expected location.

## Version Bump & Changelog

- **Changelog is always updated.** Every code or behavior change gets an entry under `## [Unreleased]` in `CHANGELOG.md`. This happens as part of normal work — do not wait for a release.
- **Version bumps only on explicit user request.** Never bump the version in `source/cli/package.json` unless the user explicitly asks for a release. When they do:
  1. Bump version (patch/minor/major per [semver](https://semver.org/)).
  2. Run `npm install` in `source/cli/` to update `package-lock.json`.
  3. Move current version entries to a release section in `CHANGELOG.md`.
- **Two distinct version notions — do not conflate them.** The `package.json` version is the release/marketing version and moves on every release. The **graph schema version** is separate: it lives in `CLI_SUPPORTED_SCHEMA` (`core/graph-loader.ts`) and the `version:` field of `templates/default-config.ts`, and it advances ONLY when the graph format/migrations change — never for a code-only patch. `yg init` compares a project's graph version against `CLI_SUPPORTED_SCHEMA` (not the package version) to decide whether an upgrade is needed. Bumping `package.json` does NOT require bumping the schema version; bump the schema version (in both places, plus a migration) only when the graph format actually changes.

## CLI Message Design Principle

Every diagnostic message the CLI outputs to an agent must follow the **what / why / next** structure:

- **WHAT** happened — facts, one line or short block
- **WHY** it's a problem — context the agent needs to understand the situation
- **NEXT** — concrete command or instruction to resolve

Use `buildIssueMessage({ what, why, next })` from `source/cli/src/formatters/message-builder.ts` for all error/warning messages in validator, check, approve, and build-context. The builder enforces the structure; the caller handles presentation (indentation, error code prefix).

This applies to CLI output only. Rules.ts (system prompt) provides the map — workflow, vocabulary, categories. CLI provides the GPS — specific errors, next commands. They share vocabulary but never duplicate information.

## Quality Gate

**ALWAYS run `scripts/repo-check.sh` from repo root before ANY commit and ensure it passes cleanly.** Do not commit with failing checks. This is non-negotiable — every commit must leave the repo in a green state. The script runs typecheck, lint, build, tests with coverage, docs build, markdown lint, and `yg check` in sequence. Do not run these individually before committing — `repo-check.sh` covers everything. The pre-commit hook also runs `repo-check.sh`, so there is no need to run it manually before committing either.

## Dogfood Issue Tracking

While working in this repo, if you encounter a problem with the CLI itself or with the rules/knowledge content (contradictions, missing warnings, misleading examples), append an entry to `.temp/dogfood-report.md`. Format:

```
## <date> — <short title>
**WHAT:** <what happened>
**WHERE:** <file:line or command>
**WHY:** <why it matters>
**REPRO:** <steps to reproduce>
```

Mark entries **RESOLVED** (with commit SHA) once fixed, or **DEFERRED** (with reason) when punted.

## Memory

Do NOT use the auto memory system. All persistent knowledge goes into CLAUDE.md or AGENTS.md — nowhere else.

## When Evaluating `yg check` or `scripts/repo-check.sh`

Consider both:

1. **Product** — Is the command correct and useful for adopters?
2. **Dogfood** — Is this repo's graph coverage correct and complete?
