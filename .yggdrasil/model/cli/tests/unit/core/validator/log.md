## [2026-05-16T13:59:47.325Z]
Update test fixtures to match updated Graph model types: nodeParseErrors entries now use messageData: IssueMessage instead of message: string; architectureError raw string replaced with structured { code, messageData } object.
## [2026-05-26T08:07:19.411Z]
Update aspect-verifier.test.ts: add errorSource: 'codeViolation' to mock provider responses and toEqual assertions. Required field change means all mock AspectResponse objects and assertions must include errorSource.
