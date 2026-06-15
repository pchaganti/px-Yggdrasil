---
id: python-relative-escape-silence
language: python
category: trap
expectation: silence
cites: "PEP 328 — relative imports are resolved against package position; a dot-count climbing past the repo root cannot reach an in-repo file; research 2026-06-15 PART C §C4"
---

## Rule

A relative import whose dot-count climbs PAST the repo root cannot resolve to any in-repo
file — the parent package lies outside the analyzed tree. From `src/app/main.py` (two
directories deep), `from ....deep import w` (four dots) climbs three parents, escaping
above the root; the climb guard detects the stalled `dirname` and the post-join
`normalize().startsWith('..')` catches the escape → undefined. Even with a same-named
`deep.py` inside the tree, the resolver returns nothing — never a mis-bind to a coincidental
file.

## Files

```python path=src/deep.py
def w():
    pass
```

```python path=src/app/main.py
from ....deep import w
```

## Expect

- silence      # four dots from a 2-deep file climb above the repo root → escape guard fires → no edge, even with an in-tree deep.py

## Why

A real over-climb would (in CPython) raise ImportError or reach a parent outside the repo,
never an in-repo file the analyzer should flag; silence is the correct zero-FP outcome,
and the same-named in-tree file is structurally unreachable from this climb.
