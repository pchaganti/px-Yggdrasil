---
id: 01-clean-approved
category: wellformed
expectation: verdict
---

## Rule

Well-formed approval — the happy path: valid JSON with a boolean satisfied.

## Input

````text
{"satisfied": true, "reason": "Every handler emits an audit event before mutating state."}
````

## Expect

- satisfied: true
- error_source: codeViolation
- reason_includes: audit
