---
id: 15-garbled-no-verdict-field
category: infra
expectation: infra
---

## Rule

Prose contains the WORD satisfied but no "satisfied": field — must NOT become a false PASS; classified as a provider/infra error (A3b).

## Input

````text
Overall the code looks satisfied and fine to me. No structured verdict provided.
````

## Expect

- error_source: provider
