## [2026-05-15T17:44:39.950Z]
Phase 2: split cli-base.ts from cli/llm/providers into standalone node. Type: llm-subprocess-base (base class for subprocess-based LLM providers).
## [2026-05-26T08:03:07.256Z]
Migrate cli-base.ts to errorSource enum mirroring sibling provider files.
## [2026-05-29T20:38:46.544Z]
The CLI reviewer provider now drains the child process's stderr stream (an unread stderr pipe can deadlock the child once its buffer fills on verbose output), and the default per-call subprocess timeout was raised from 120s to 300s. A large node's per-aspect prompt — many source files plus references — can legitimately take roughly 100 to 300 seconds to review through a CLI-spawned model; the old 120s ceiling sat right at that boundary, so big-node reviews intermittently exceeded it and surfaced as a spurious 'Reviewer unavailable'. Keeping nodes small is the durable fix; the higher default just removes the boundary flakiness, and the timeout remains tunable per tier.
