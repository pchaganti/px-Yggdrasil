## [2026-05-26T08:07:23.902Z]
Update cli-base.test.ts assertions to include errorSource: 'codeViolation' in toEqual checks (parseAspectResponse now normalizes all returned objects to include errorSource). Add error-source.test.ts: behavioral tests for AspectResponse errorSource filter semantics.
