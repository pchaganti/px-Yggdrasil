## [2026-05-12T11:24:00.198Z]
Extend mandatory log entry check to first approve: new nodes with source files now require a log entry on initial approve (when log_required: true). Gated by whether source files exist in mapping — logical nodes and log_required:false are unaffected. Fixes spec gap where spec data flow showed bootstrap failing without log entry.
## [2026-05-12T11:29:58.258Z]
Bootstrap mandatory log entry check: first approve on a node that has source files now requires at least one log entry when log_required is true (default). Previously the mandatory check was gated on storedEntry?.log, meaning it was skipped entirely for new nodes. Now the first-approve path checks log entries and returns refused if none exist. log_required: false still bypasses the check. Added three new unit tests in approve-log.test.ts and two integration tests in log-workflow.test.ts. Updated bootstrapApprove helper in integration tests to include a log entry before the first approve. Added log_required: false to sample-project fixture to isolate pipeline mechanics tests from log enforcement tests. Updated approve.test.ts to provide a log entry for the first-approve test.
## [2026-05-15T12:24:34.149Z]
R0.3: cascade from cli/io metadata update
## [2026-05-15T12:36:42.937Z]
R0.4b: cascade from cli/io metadata update (atomic-write.ts added to mapping)
## [2026-05-15T12:41:10.716Z]
R0.5: graph-loader.ts now routes all fs calls through io/graph-fs.ts (readSortedDir, readTextFile)
## [2026-05-15T13:21:54.671Z]
R0.6: update log-parser import — approve.ts now imports parseLog from ./parsing/log-parser (moved from io/). No logic change.
## [2026-05-15T13:55:50.587Z]
R0.1 Phase 4: populate refuseReasonData alongside refuseReason on all refused ApproveResult returns. buildIssueMessage still called for backward compat; Phase 5 will drop refuseReason.
