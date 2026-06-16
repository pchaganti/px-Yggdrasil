# @chrisdudek/yg

**Your agent will ignore CLAUDE.md. Yggdrasil makes sure it doesn't.**

Architecture rules your agent can't ignore. Before it edits a file, your agent gets the few rules that apply — and writes to them. After, every change is checked before it moves on: by a script that runs locally for free, or by an LLM reviewer. A rule written as a script *runs* — your agent can't quietly optimize it away the way it drops a line in CLAUDE.md. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more. Checks run against your code, not your diffs; the feedback is specific; the agent has to fix before it can move on.

See the [main README](https://github.com/krzysztofdudek/Yggdrasil#readme) for documentation, or visit
[krzysztofdudek.github.io/Yggdrasil](https://krzysztofdudek.github.io/Yggdrasil/).

## Install

```bash
npm install -g @chrisdudek/yg
cd your-project
yg init
```

`yg init` walks you through picking your agent platform and a reviewer (Anthropic, OpenAI, Google, Ollama, or a local agent CLI), then writes the `.yggdrasil/` graph into your repo.

## License

MIT
