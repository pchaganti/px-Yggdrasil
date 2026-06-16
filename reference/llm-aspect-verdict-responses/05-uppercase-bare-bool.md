---
id: 05-uppercase-bare-bool
category: malformed
expectation: verdict
---

## Rule

TRUE (uppercase, invalid JSON) — strict parse fails, salvage reads the field.

## Input

````text
{"satisfied": TRUE, "reason": "fine"}
````

## Expect

- satisfied: true
- error_source: codeViolation
