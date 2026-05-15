## [2026-05-15T09:01:20.032Z]
Add yg knowledge list/read commands. Exports listKnowledge() and readKnowledge(name) as testable functions. Commander wrapper adds try/catch per cli-command-contract. Uses chalk.red for error output. Reads KNOWLEDGE_TOPICS from embedded CLI binary — no file access at runtime.
