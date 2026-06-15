---
id: python-from-import-submodule-edge
language: python
category: import
expectation: edge
cites: "Python import system — Submodules (a `from pkg import sub` where sub is a submodule file binds the submodule object); research 2026-06-15 PART B §B1 (submodule longest-match)"
---

## Rule

`from pkg import sub` where `sub` IS a submodule file is the other half of the
longest-match: `from billing import charge` emits `billing` (→ the package
`billing/__init__.py`) AND `billing.charge` (→ the submodule `billing/charge.py`). Both
files map to the SAME node `billing`, so the two specifiers resolve to one cross-node
edge to `billing`. The longest-match `billing.charge` hits the real submodule file
directly — the file probe, not a name lookup, is what distinguishes submodule from name.

## Files

```python path=src/billing/__init__.py
pass
```

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
from billing import charge

charge.charge()
```

## Expect

- src/app/main.py:1 -> node:billing      # `billing.charge` → billing/charge.py and `billing` → billing/__init__.py, both node billing → one edge

## Why

A submodule is a real file and a real dependency; probing `billing/charge.py` directly is
how the resolver tells a submodule from a name, with no guess and no phantom either way.
