# @chrisdudek/yg

**Stop babysitting your agent.**

Your architecture rules become checks it can't skip, run on every change before it moves on. A script runs them locally for free, or an LLM reviews the call a script can't make. Checks run against your code, not your diffs. The feedback is specific, and the agent has to fix before it can move on. Works with Claude Code, Cursor, Copilot, Codex, Cline, and more.

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
