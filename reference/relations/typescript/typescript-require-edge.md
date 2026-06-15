---
id: typescript-require-edge
language: typescript
category: import
expectation: edge
cites: "TS Handbook — Modules / CommonJS interop (`require('./m')` loads a CommonJS module); research D1"
---

## Rule

A CommonJS `const a = require('./a')` loads a module; the string argument is the
dependency. The extractor matches a call whose callee is the BARE `require` identifier
(not a member callee like `require.resolve`) and whose first argument is a plain string
literal, then emits the relative specifier.

## Files

```ts path=r/m/value.ts
module.exports = { go() {} };
```

```ts path=r/app/use.ts
const a = require('../m/value');
a.go();
```

## Expect

- r/app/use.ts:1 -> node:m      # `require('../m/value')` resolves to r/m/value.ts (node m)

## Why

A bare-`require` call with a string-literal argument is a real module load; the callee
identity plus the literal argument make it unambiguously the specifier.
