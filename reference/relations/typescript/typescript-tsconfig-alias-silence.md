---
id: typescript-tsconfig-alias-silence
language: typescript
category: trap
expectation: silence
cites: "tsconfig — paths/baseUrl (a compile-time-only alias requiring tsconfig.json to resolve); research G2 (DELIBERATE-SILENCE)"
---

## Rule

A tsconfig `paths`/`baseUrl` alias (`@app/x`) is a compile-time-only mapping that
requires reading `tsconfig.json` to resolve; it does not start with `.`/`/`, so the
analyzer treats it as bare and silences it. Resolving it without the real `paths` map
could pick the wrong file, so it is dropped BEFORE resolution — a tolerated
false-negative, never a mis-map. tsconfig alias resolution is out of scope for v1.

## Files

```ts path=r/app-x/value.ts
export const X = 1;
```

```ts path=r/app/use.ts
import { X } from '@app/x';
console.log(X);
```

## Expect

- silence      # `@app/x` is a non-relative tsconfig alias → out of scope → no edge

## Why

The alias-to-directory mapping is project-defined and lives only in tsconfig.json;
dropping it before resolution guarantees zero false positives at the cost of one
tolerated missed edge.
