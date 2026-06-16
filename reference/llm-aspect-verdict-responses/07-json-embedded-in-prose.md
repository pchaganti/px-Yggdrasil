---
id: 07-json-embedded-in-prose
category: malformed
expectation: verdict
---

## Rule

Valid verdict object after prose that itself contains braces — must pick the verdict object, not the prose braces.

## Input

````text
I reviewed the file. The message shape { what, why, next } is fine.
Verdict: {"satisfied": false, "reason": "no input validation on the command path"}
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: validation
