---
id: typescript-require-no-argument-silence
language: typescript
category: dynamic
expectation: silence
cites: "TS Handbook — Modules (a `require()` with no/non-string argument has no static specifier); research D6"
---

## Rule

A `require()` with no argument has a null first argument, and `require(dynamicVar)` has
a non-string first argument; neither yields a static specifier. Only a plain string
literal becomes a specifier, so a require with no/non-string argument is silenced —
guessing a target would be a false positive.

## Files

```ts path=r/app/use.ts
const x = require();
const y = require(dynamicVar);
```

## Expect

- silence      # `require()` / `require(dynamicVar)` have no string-literal specifier → no edge

## Why

Without a string-literal argument there is no statically resolvable target; emitting any
guess would be a false positive.
