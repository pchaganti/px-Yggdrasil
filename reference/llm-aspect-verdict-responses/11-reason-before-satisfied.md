---
id: 11-reason-before-satisfied
category: wellformed
expectation: verdict
---

## Rule

Reason field precedes the satisfied field.

## Input

````text
{"reason": "everything looks correct", "satisfied": true}
````

## Expect

- satisfied: true
- error_source: codeViolation
