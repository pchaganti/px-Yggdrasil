---
id: typescript-relative-resolves-tsx-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution (relative join + extension probing picks `.tsx`); research F1"
---

## Rule

A relative specifier resolves against the importing file's directory; the resolver
probes source extensions in order — `.ts`, then `.tsx`, … — so an extension-less
`'../widget/Widget'` binds to `Widget.tsx` when no `.ts` twin exists. The relative join
pins the directory, so a same-basename file under another directory is never in the
candidate set.

## Files

```tsx path=r/widget/Widget.tsx
export const Widget = () => null;
```

```ts path=r/app/use.ts
import { Widget } from '../widget/Widget';
const w = Widget;
```

## Expect

- r/app/use.ts:1 -> node:widget      # `'../widget/Widget'` probes extensions → r/widget/Widget.tsx (node widget)

## Why

Extension probing finds the `.tsx` target under the pinned directory; a same-named file
elsewhere is structurally unreachable through the relative join.
