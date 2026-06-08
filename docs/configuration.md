---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file and configures the reviewer interactively.
`yg init --upgrade` migrates the graph (config, aspects, drift-state baselines) to
the current version and refreshes the rules, schemas, and platform files.

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
version: "5.0.0"

reviewer:
  default: standard                 # Required when more than one tier; optional with one
  tiers:
    standard:                       # Tier name — referenced by aspect reviewer.tier
      provider: ollama              # LLM provider
      consensus: 1                  # Votes per aspect (odd integer >= 1)
      config:
        model: qwen3
        endpoint: http://localhost:11434
        temperature: 0

coverage:                             # Optional — controls which files must be mapped
  required:                           # Unmapped files under these roots are a blocking error
    - "/"                             # Default: whole repo (previous always-map-everything behavior)
  excluded: []                        # Files under these roots are silently ignored

quality:
  max_direct_relations: 10
  max_node_chars: 40000

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
| `config.model` | yes | Provider-specific model identifier |
| `config.temperature` | no | Sampling temperature. Defaults to `0`. |
| `config.endpoint` | required for `ollama`, `openai-compatible` | API endpoint URL |
| `config.timeout` | no | Per-call timeout in seconds. Defaults to `300`. Applies to CLI providers only (non-CLI/API providers ignore it). |
| `config.context_length_field` | no | Ollama: model info field override for context length |

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

## API keys and secrets

Credentials go in `.yggdrasil/yg-secrets.yaml` (gitignored by default):

```yaml
# .yggdrasil/yg-secrets.yaml — gitignored, never commit
reviewer:
  anthropic:
    api_key: sk-ant-...
  openai:
    api_key: sk-...
  google:
    api_key: AI...
```

API providers also check environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`. If the env var is set, `yg-secrets.yaml` is not required.

`yg-config.yaml` itself must never contain credentials. Commit it to the repository.

---

## Coverage config

```yaml
coverage:
  required:
    - src/             # files under src/ must be mapped — unmapped is a blocking error
  excluded:
    - vendor/          # files under vendor/ are silently ignored
```

Controls which git-tracked files must be mapped to a node in `yg check`.

- **`required`** — List of path roots. Files under a required root that are not mapped to any node produce an `unmapped-files` error (blocks CI). Default: `["/"]` (the whole repo — reproduces the previous always-map-everything behavior).
- **`excluded`** — List of path roots. Files under an excluded root are silently ignored regardless of other rules.
- Files that match neither a required nor an excluded root produce a non-blocking `uncovered-advisory` warning.
- Subtrees that contain their own nested `.yggdrasil/` are auto-skipped by all repo-walking checks — they are governed by their own graph, not the root graph.

Each file is scored against all roots independently; the longest matching root wins, and on an equal-length tie between a required and an excluded root, excluded wins.

---

## Quality config

```yaml
quality:
  max_direct_relations: 10        # Max out-edges per node (high-fan-out warning)
  max_node_chars: 40000           # Per-node character budget — source + aspect reference files (oversized-node error)
```

`max_direct_relations` fires a warning when exceeded. `max_node_chars` is a blocking
error: a node whose mapped source plus aspect reference files exceed it (binary files
do not count) must be split into children. For a node mapping a single unsplittable
generated or binary artifact (a lockfile, an append-only changelog, an image), opt out
per-node with `sizeExempt: { reason: "<why it cannot be split>" }`.

---

## Upgrading

```bash
yg init --upgrade
```

Migrates the graph to the current version: applies registered migrations to `yg-config.yaml`,
all `yg-aspect.yaml` files, and drift-state baselines (losslessly re-keyed to the typed format),
then refreshes the rules, schemas, and platform files. The legacy single-section reviewer format
(flat provider keys + `reviewer.active`) is migrated to `reviewer.tiers` automatically. Run from
the repository root only. Review the diff before committing.

---

## Notes

- `yg-node.yaml` is a reserved filename in model directories.
- Node types are defined in `yg-architecture.yaml`, not `yg-config.yaml`.
