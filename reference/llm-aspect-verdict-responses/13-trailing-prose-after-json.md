---
id: 13-trailing-prose-after-json
category: malformed
expectation: verdict
---

## Rule

Valid verdict object followed by trailing prose.

## Input

````text
{"satisfied": false, "reason": "missing null check"}

That is my final verdict.
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: null check
