## [2026-05-15T13:00:15.734Z]
Initial creation: split from cli/io parent (wide-node false positive blocked silent-missing-files approve with 14 files). Parsers child contains 8 parser files; inherits yaml-parser-contract, silent-missing-files, diagnostic-logging from parent via channel 2. log-parser.ts stays here temporarily until R0.6 moves it to core/parsing.
## [2026-05-15T13:09:48.512Z]
Aspect restructuring: removed silent-missing-files from parent inheritance (parent cli/io now has no aspects). Parsers explicitly declares yaml-parser-contract + diagnostic-logging only. silent-missing-files is irrelevant to parsers since they do not read optional resources — they either parse required files or throw. secrets-parser.ts handles optional yg-secrets.yaml but is itself a parser not a store; yaml-parser-contract + diagnostic-logging are the correct effective aspects for this child.
## [2026-05-15T13:21:54.979Z]
R0.6: update when-parser and file-when-parser imports — architecture-parser.ts, flow-parser.ts, node-parser.ts now import from ../core/parsing/ (files moved from io/). log-parser.ts removed from this node mapping (now owned by cli/core/parsing).
## [2026-05-15T13:26:16.840Z]
R0.6: fix aspect-parser.ts import — when-parser moved to core/parsing/ so import updated from './when-parser.js' to '../core/parsing/when-parser.js'. No logic change.
