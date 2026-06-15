---
id: typescript-intra-node-import-silence
language: typescript
category: import
expectation: silence
cites: "Relation-conformance (a dependency within one node is not a cross-node edge); research H-class (intra-node is benign)"
---

## Rule

A relative import that resolves to a file in the SAME node as the importer is an
intra-node dependency, never a cross-node edge. Two files sharing a directory belong to
one node; `'./sibling'` from `r/app/use.ts` resolves to `r/app/sibling.ts` — same node —
so the resolved owner equals the from-node and no edge is emitted. The import statement
is real, but it crosses no node boundary.

## Files

```ts path=r/app/sibling.ts
export const a = 1;
```

```ts path=r/app/use.ts
import { a } from './sibling';
console.log(a);
```

## Expect

- silence      # `'./sibling'` resolves to r/app/sibling.ts — same node as the importer → no cross-node edge

## Why

A dependency entirely inside one node carries no relation to declare; only a resolved
owner DIFFERENT from the importing node becomes an edge.
