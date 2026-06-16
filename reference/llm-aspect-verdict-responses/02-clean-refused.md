---
id: 02-clean-refused
category: wellformed
expectation: verdict
---

## Rule

Well-formed refusal.

## Input

````text
{"satisfied": false, "reason": "charge() mutates state at line 5 without calling emitAudit()."}
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: emitAudit
