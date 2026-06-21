---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file and configures the reviewer interactively.
`yg init --upgrade` lifts the graph's config version to the current one and
refreshes the rules and platform files.

---

## Schema

### Required

- **version** — Schema version managed by the CLI. Do not edit manually. Run `yg init --upgrade` to upgrade.
- **reviewer** — Reviewer configuration; must contain `tiers` with at least one entry. Configured during `yg init`; see [Reviewer tiers](#reviewer-tiers) below.

### Optional

- **reviewer.default** — Tier name aspects fall back to when they don't declare one. Required when `reviewer.tiers` has more than one entry; optional with exactly one tier.
- **coverage** — Controls which files must be mapped to a node (see [Coverage config](#coverage-config) below).
- **quality** — Quality thresholds (see [Quality config](#quality-config) below).
- **parallel** — Concurrent aspect verifications across nodes (positive integer).
- **debug** — Set `true` to append all CLI output to `.yggdrasil/.debug.log`.

Node types are defined in the separate **architecture file** (`.yggdrasil/yg-architecture.yaml`),
not in `yg-config.yaml`.

---

## Full annotated example

```yaml
version: "5.1.0"

reviewer:
  default: standard                 # Required when more than one tier; optional with one
  tiers:
    standard:                       # Tier name — referenced by aspect reviewer.tier
      provider: ollama              # LLM provider
      consensus: 1                  # Votes per aspect (odd integer >= 1)
      max_prompt_chars: 50000       # Cap on the assembled prompt (optional; absent defaults to 50000)
      config:
        model: qwen3
        endpoint: http://localhost:11434
        temperature: 0

coverage:                             # Optional — controls which files must be mapped
  required:                           # Unmapped files under these roots are a blocking error
    - "/"                             # Default: whole repo
  excluded: []                        # Files under these roots are silently ignored

quality:
  max_direct_relations: 10

parallel: 10
debug: false
```

---

## Reviewer tiers

Reviewer configuration uses **named tiers**. Each tier is an independent LLM
configuration. Aspects target a tier via `reviewer.tier: <name>` in
`yg-aspect.yaml`. If no `tier:` is declared on an aspect, the aspect uses
`reviewer.default` from the config.

### reviewer.default

The tier name aspects fall back to when they don't declare `reviewer.tier:`.

- **Required** when `reviewer.tiers` has more than one entry — the validator
  emits `config-default-tier-missing` otherwise.
- **Optional** when `reviewer.tiers` has exactly one entry; the single tier is
  the implicit default.
- Must reference a key under `reviewer.tiers`.

### reviewer.tiers.\<name\>

Tier name regex: `^[a-zA-Z][a-zA-Z0-9_-]{0,62}$`. The literal name `default` is
**reserved** (it would clash with `reviewer.default` visually). Convention:
`standard` for the primary tier. Add a second tier (e.g. `deep`) for aspects
that need a higher-capability model.

```yaml
reviewer:
  default: deep
  tiers:
    standard:
      provider: anthropic
      consensus: 3
      config:
        model: claude-opus-4-7
        temperature: 0
    deep:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        endpoint: http://localhost:11434
```

An aspect targeting the `standard` tier (overriding the default):

```yaml
reviewer:
  type: llm
  tier: standard
```

An aspect with no explicit tier uses `reviewer.default` (`deep` in the above example):

```yaml
reviewer:
  type: llm
```

### Fields per tier

| Field | Required | Description |
| --- | --- | --- |
| `provider` | yes | One of the supported providers (see below) |
| `consensus` | yes | Positive odd integer. `1` = single call. `3` = majority vote. |
| `max_prompt_chars` | no | Positive integer. Caps the assembled-prompt length for LLM pairs on this tier (see [Prompt-size gate](#prompt-size-gate)). Absent defaults to 50000. `yg init` writes `50000`. |
| `config.model` | yes | Provider-specific model identifier |
| `config.temperature` | no | Sampling temperature. Defaults to `0`. |
| `config.endpoint` | required for `openai-compatible` (ollama defaults to `http://localhost:11434`) | API endpoint URL |
| `config.timeout` | no | Per-call timeout in seconds. Defaults to `300`. Applies to CLI providers only (non-CLI/API providers ignore it). |

Unknown `config.*` keys are silently ignored (no error, no warning) — only the
keys listed above are read.

### Supported providers

| Provider | Type | Notes |
| --- | --- | --- |
| `ollama` | local | No API cost; requires local install |
| `anthropic` | API | Requires `ANTHROPIC_API_KEY` or `yg-secrets.yaml` |
| `openai` | API | Requires `OPENAI_API_KEY` |
| `google` | API | Requires `GOOGLE_API_KEY` |
| `openai-compatible` | API | Any OpenAI-compatible endpoint |
| `claude-code` | CLI | Delegates to the installed `claude` CLI |
| `codex` | CLI | Delegates to the installed `codex` CLI |
| `gemini-cli` | CLI | Delegates to the installed `gemini` CLI |

CLI providers (claude-code, codex, gemini-cli) require no API key — they delegate to the
installed CLI tool.

---

## Secrets and local overrides

`.yggdrasil/yg-secrets.yaml` is a deep-merge overlay over `yg-config.yaml`
(gitignored by default). It mirrors the same shape, and any field in it wins —
use it for a tier's API key, or to point a named tier at a different
provider/model/endpoint on your machine:

```yaml
# .yggdrasil/yg-secrets.yaml — gitignored, never commit
reviewer:
  tiers:
    standard:
      config:
        api_key: sk-ant-...
```

Because only the tier **name** is folded into a verdict's hash, a local override
never invalidates recorded baselines: the committed config names a canonical
reviewer, and each machine points the same named tier at its own provider, model,
or key.

API providers also check environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`. If the env var is set, the key is not needed in `yg-secrets.yaml`.

`yg-config.yaml` itself must never contain credentials. Commit it to the repository.

---

## Coverage config

```yaml
coverage:
  required:
    - src/                  # files under src/ must be mapped — unmapped is a blocking error
  excluded:
    - vendor/               # files under vendor/ are silently ignored
    - "**/*.generated.ts"   # glob: generated files anywhere are ignored
```

Controls which git-tracked files must be mapped to a node in `yg check`.

- **`required`** — List of roots. Files under a required root that are not mapped to any node produce an `unmapped-files` error (blocks CI). Default: `["/"]` (the whole repo — reproduces the previous always-map-everything behavior). An explicit empty list `[]` means **require nothing** — every uncovered file (outside `excluded`/nested) becomes a non-blocking `uncovered-advisory` warning and nothing blocks (pure-advisory adoption: you still see the full uncovered surface, but CI stays green on coverage). The empty list only takes effect when written explicitly; omitting the whole `coverage` block keeps the `["/"]` default.
- **`excluded`** — List of roots. Files under an excluded root are silently ignored regardless of other rules.
- **Roots accept the same forms as a node `mapping:` entry** — an exact file, a directory prefix (e.g. `src/`), or a [minimatch](https://github.com/isaacs/minimatch) glob (`*` within a path segment, `**` across segments). So `excluded: ["**/*.generated.ts"]` ignores generated files anywhere, and `required: ["services/*/api/**"]` scopes the blocking tier to a pattern. `/` still means the whole repo.
- Files that match neither a required nor an excluded root produce a non-blocking `uncovered-advisory` warning.
- Subtrees that contain their own nested `.yggdrasil/` are auto-skipped by all repo-walking checks — they are governed by their own graph, not the root graph.

Each file is scored against all roots independently; the longest matching root (or pattern, by length) wins, and on an equal-length tie between a required and an excluded root, excluded wins.

---

## Prompt-size gate

A tier's optional `max_prompt_chars` caps the length of the prompt the LLM
reviewer assembles for each pair. The prompt for each LLM pair is composed of:
the rule text (`content.md`), any static reference files, the unit's subject files,
and — when the aspect ships a `companion.mjs` — any companion files the hook
resolved for that unit. All of these count toward the limit.

`yg check` measures the assembled prompt for every expected LLM pair and reports
`prompt-too-large` — a blocking error — when it exceeds the resolved tier's limit.
The check is deterministic and costs nothing; deterministic pairs have no prompt
and are never subject to it.

```yaml
reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      max_prompt_chars: 50000
      config: { model: claude-haiku-4-5, temperature: 0 }
```

When a pair trips the gate, the remedies in safety order are:

1. **Narrow `scope.files`** on the aspect so non-target payload (fixtures, generated
   files) drops out of the subject set.
2. **Switch the aspect to `per: file`** — only if the rule is file-local; a per-file
   reviewer cannot judge a cross-file rule.
3. **Split the node** into children.
4. **Raise the limit** or move the aspect to a higher-limit tier — but tier choice is
   part of a pair's identity, so a tier edit re-verifies every pair resolving to it.

`max_prompt_chars` is a gate, not a verdict input: lowering it can make an
already-verified pair trip the gate without invalidating its recorded verdict.

---

## Quality config

```yaml
quality:
  max_direct_relations: 10        # Max out-edges per node (high-fan-out warning)
```

`max_direct_relations` fires a warning when a node's outgoing relation count
exceeds it — a signal that the node may be doing too much. It is the only
quality threshold.

---

## Upgrading

```bash
yg init --upgrade
```

Lifts the graph's config version to the current one and refreshes the rules,
schemas, and platform files. The legacy single-section reviewer format (flat
provider keys + `reviewer.active`) is migrated to `reviewer.tiers` automatically.
Retired fields are SILENTLY IGNORED — a `yg-config.yaml` still carrying
`quality.max_node_chars`, per-tier `config.references:` size caps, or other
retired `config.*` keys (e.g. `config.context_length_field`) produces no error and
no warning; the parser simply does not read them. Review the diff after upgrade
and delete the dead lines by hand. This is distinct from the parser's
unknown-KEY guard: a typo'd key under `reviewer:` or under a tier still fails
`yg check` with a clear `config-reviewer-unknown-key` / `config-tier-unknown-key`
error — a key typo is caught, a retired-field cleanup is not. Run from the
repository root only. Review the diff before committing.

---

## Notes

- `yg-node.yaml` is a reserved filename in model directories.
- Node types are defined in `yg-architecture.yaml`, not `yg-config.yaml`.
