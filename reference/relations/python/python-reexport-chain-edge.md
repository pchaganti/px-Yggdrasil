---
id: python-reexport-chain-edge
language: python
category: import
expectation: edge
cites: "Python import system — Submodules / package namespace binding (a package `__init__.py` re-export surfaces submod.X as pkg.X); research 2026-06-15 PART E §E3"
---

## Rule

A package `__init__.py` commonly re-exports a submodule symbol — `from .impl import
Service` surfaces `impl.Service` as `billing.Service`. Each end is an ORDINARY import
resolved by file path; the chain is DELIBERATELY not traced by name. A consumer's
`from billing import Service` emits `billing` + `billing.Service`, both → the
`__init__.py` where the binding actually lives (node `billing`) — the correct file-path
edge. The `__init__.py`'s own `from .impl import Service` is intra-package (same node
`billing`), so it adds no separate cross-node edge, and the consumer edge is NEVER
re-attributed to `impl.py` (that would require name-axis tracing the path-axis avoids).

## Files

```python path=src/billing/impl.py
class Service:
    pass
```

```python path=src/billing/__init__.py
from .impl import Service
```

```python path=src/app/main.py
from billing import Service

Service()
```

## Expect

- src/app/main.py:1 -> node:billing      # `from billing import Service` resolves to billing/__init__.py (where the re-export binds it), node billing — the chain is not traced to impl.py

## Why

Both ends are file-path imports resolved independently; tracing the re-export to the
original `impl.py` would re-introduce name-axis FP risk, so the consumer edge points at
the file that binds the name (`__init__.py`), a correct and zero-FP path-based edge.
