---
id: 09-truncated-no-closing
category: malformed
expectation: verdict
---

## Rule

Reason cut off mid-sentence, no closing "} at all — salvage still recovers the verdict.

## Input

````text
{"satisfied": false, "reason": "The stream is opened in read() but never closed, so the descriptor leaks when the loop
````

## Expect

- satisfied: false
- error_source: codeViolation
- reason_includes: leaks
