---
id: 08-unescaped-quote-in-reason
category: malformed
expectation: verdict
---

## Rule

Unescaped double-quotes inside the reason make it invalid JSON — salvage keeps the verdict and the raw reason.

## Input

````text
{"satisfied": false, "reason": "The rule "Every catch block must call debugWrite()" is violated in handler() at line 12."}
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: catch block
