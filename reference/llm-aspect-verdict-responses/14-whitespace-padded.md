---
id: 14-whitespace-padded
category: wellformed
expectation: verdict
---

## Rule

Leading/trailing whitespace and newlines around clean JSON.

## Input

````text


   {"satisfied": true, "reason": "ok"}   
````

## Expect

- satisfied: true
- error_source: codeViolation
