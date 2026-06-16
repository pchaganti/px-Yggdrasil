---
id: 12-nested-braces-in-reason
category: wellformed
expectation: verdict
---

## Rule

Valid JSON whose reason string legitimately contains braces.

## Input

````text
{"satisfied": true, "reason": "the block { open(); use(); close(); } is balanced and safe"}
````

## Expect

- satisfied: true
- error_source: codeViolation
- reason_includes: balanced
