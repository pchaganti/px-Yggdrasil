@.yggdrasil/agent-rules.md
@AGENTS.md

## Memory

Do NOT use the auto memory system. All persistent knowledge goes into CLAUDE.md or AGENTS.md — nowhere else.

## Checks

`scripts/repo-check.sh` runs everything: typecheck, lint, build, tests with coverage, docs, markdownlint, `yg check`. Do NOT run any of these individually — use only `repo-check.sh`. The pre-commit hook also runs `repo-check.sh`, so there is no need to run it manually before committing either.
