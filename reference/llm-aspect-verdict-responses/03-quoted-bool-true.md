---
id: 03-quoted-bool-true
category: wellformed
expectation: verdict
---

## Rule

satisfied is the quoted string "true", not a JSON boolean — must coerce to true.

## Input

````text
{"satisfied": "true", "reason": "ok"}
````

## Expect

- satisfied: true
- error_source: codeViolation
