---
id: typescript-import-attribute-json-silence
language: typescript
category: import
expectation: silence
cites: "TS 5.3 import attributes (`with { type: 'json' }` is a trailer; `.json` is not a probed source candidate); research H6"
---

## Rule

A whole-statement import attribute `import data from './a.json' with { type: 'json' }`
keeps the specifier on the `from` clause; the `with` clause is a trailer the extractor
ignores (it reads only the `source` field). The emitted `.json` specifier then resolves
to SILENCE because the resolver probes `.ts/.tsx/.js/.jsx/.mjs/.cjs` + index — never
`.json`. A JSON asset is not a source candidate, so no edge is recorded.

## Files

```json path=r/data/a.json
{ "a": 1 }
```

```ts path=r/app/use.ts
import data from '../data/a.json' with { type: 'json' };
console.log(data);
```

## Expect

- silence      # `.json` is not a probed source candidate → resolves to nothing → no edge; the `with` clause never confuses the specifier

## Why

The import attribute is a trailer that does not change specifier extraction, and a JSON
asset is outside the source-extension candidate set, so the statement correctly silences.
