---
id: 10-cot-and-unescaped-quote
category: malformed
expectation: verdict
---

## Rule

Models the real abliterated-35B failure: chain-of-thought leaked into the reason field plus an unescaped quote — the verdict (true) must survive.

## Input

````text
{"satisfied": true, "reason": "Wait, let me re-read the rule: "Every catch block that handles an error without re-throwing must call debugWrite()". The only catch here re-throws, so it is exempt. Thus, the requirement is satisfied."}
````

## Expect

- satisfied: true
- error_source: codeViolation
- reason_includes: re-read the rule
