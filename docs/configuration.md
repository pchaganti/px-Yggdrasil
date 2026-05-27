---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file and configures the reviewer interactively.
`yg init --upgrade` applies migrations when moving to a newer version.

---

## Schema

### Required

- **version** — Schema version set by the CLI. Run `yg init --upgrade` to migrate.

### Optional

- **reviewer** — LLM reviewer configuration. Configured during `yg init`; see [Reviewer tiers](#reviewer-tiers) below.
- **quality** — Quality thresholds (see [Quality config](#quality-config) below).
- **debug** — Set `true` to append all CLI output to `.yggdrasil/.debug.log`.

Node types are defined in the separate **architecture file** (`.yggdrasil/yg-architecture.yaml`),
not in `yg-config.yaml`.

---

## Full annotated example

```yaml
version: "5.0.0"

reviewer:
  tiers:
    standard:                       # Tier name — referenced by aspect reviewer.tier
      provider: ollama              # LLM provider
      consensus: 1                  # Votes per aspect (odd integer >= 1)
      config:
        model: qwen3
        endpoint: http://localhost:11434
        temperature: 0
        max_tokens: auto

quality:
  max_direct_relations: 10
  max_mapping_source_files: 10

debug: false
```

---

## Reviewer tiers

v5 uses **named tiers**. Each tier is an independent LLM configuration.
Aspects target a tier via `reviewer.tier: <name>` in `yg-aspect.yaml`.
If no `tier:` is declared on an aspect, the first tier in the config is used.

### reviewer.tiers.\<name\>

Tier name can be any string except the reserved word `default`. Convention: `standard` for
the primary tier. Add a second tier (e.g. `fast`) for aspects that tolerate a cheaper model.

```yaml
reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 3
      config:
        model: claude-opus-4-7
        temperature: 0
    fast:
      provider: ollama
      consensus: 1
      config:
        model: qwen3
        endpoint: http://localhost:11434
```

An aspect targeting the `fast` tier:

```yaml
reviewer:
  type: llm
  tier: fast
```

### Fields per tier

| Field | Required | Description |
| --- | --- | --- |
| `provider` | yes | One of the supported providers (see below) |
| `consensus` | yes | Positive odd integer. `1` = single call. `3` = majority vote. |
| `config.model` | yes | Provider-specific model identifier |
| `config.temperature` | no | Sampling temperature. Defaults to `0`. |
| `config.endpoint` | required for `ollama`, `openai-compatible` | API endpoint URL |
| `config.max_tokens` | no | Response budget. `auto` queries the provider. |
| `config.timeout` | no | Per-call timeout in seconds |
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

## Quality config

```yaml
quality:
  max_direct_relations: 10        # Max out-edges per node (wide-node warning)
  max_mapping_source_files: 10    # Max files per node mapping (wide-node warning)
```

Both thresholds fire warnings (not errors) when exceeded. Violations appear in `yg check`
output as `wide-node` warnings. Split large nodes into children to stay under the thresholds.

---

## Upgrading

```bash
yg init --upgrade
```

Reads the existing `yg-config.yaml`, applies migrations, and writes the updated version.
Migrations include the v4 → v5 reviewer format change (flat provider keys → `reviewer.tiers`).
Run from the repository root only. Review the diff before committing.

---

## Notes

- `yg-node.yaml` is a reserved filename in model directories.
- Node types are defined in `yg-architecture.yaml`, not `yg-config.yaml`.
