---
id: 04-quoted-bool-false
category: wellformed
expectation: verdict
---

## Rule

satisfied is the quoted string "false" — must coerce to false.

## Input

````text
{"satisfied": "false", "reason": "missing guard"}
````

## Expect

- satisfied: false
- error_source: codeViolation
