---
id: 06-markdown-fenced
category: wellformed
expectation: verdict
---

## Rule

Verdict wrapped in a ```json markdown fence.

## Input

````text
```json
{"satisfied": true, "reason": "compliant"}
```
````

## Expect

- satisfied: true
- error_source: codeViolation
