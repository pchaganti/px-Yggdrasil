## [2026-05-15T09:57:38.730Z]
resolveFileArg call updated: cwd arg removed, file arg now repo-root-relative
## [2026-05-15T14:17:01.037Z]
Drop deprecated .message field: build-context.ts now renders ValidationIssue via buildIssueMessage(err.messageData). R0.1 Phase 5.
## [2026-05-15T14:23:01.259Z]
Fix ENOENT handler to use buildIssueMessage: 'Run yg init first' is a remediation command requiring structured what/why/next format per what-why-next aspect.
## [2026-05-15T14:25:36.164Z]
Fix node normalization: remove extra .replace(/^\.\//,'') not in cli-command-contract; restore ENOENT message to required verbatim string per cli-command-contract (what-why-next aspect updated to exempt this standardized string).
