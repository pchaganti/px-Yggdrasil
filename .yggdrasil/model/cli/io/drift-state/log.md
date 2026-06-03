## [2026-06-03T07:05:36.970Z]
Drift-state persistence was carved into its own node so the store that reads, writes, and garbage-collects per-node baselines stays small enough to review whole after the surrounding I/O layer grew past the per-node budget. Every write still routes through the atomic-write port so a crash or signal never leaves a partial baseline on disk.
