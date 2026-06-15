---
id: python-relative-parent-import-edge
language: python
category: import
expectation: edge
cites: "PEP 328 — two or more leading dots give a relative import to the parent package, one level per dot after the first; PEP 366 — `__package__` anchoring; research 2026-06-15 PART C §C3"
---

## Rule

`from ..pkg import x` (two dots) climbs `dots − 1` = one parent from the importer's
package, then appends the tail. From `src/app/sub/handler.py`, `from ..billing import
charge` climbs `src/app/sub` → `src/app`, then resolves `..billing` →
`src/app/billing/__init__.py` and `..billing.charge` → `src/app/billing/charge.py` (node
`billing`) — a cross-node edge from node `sub`. The dot-count climb is deterministic; a
climb landing inside the repo is a legitimate resolution, never an escape.

## Files

```python path=src/app/billing/__init__.py
pass
```

```python path=src/app/billing/charge.py
def charge():
    pass
```

```python path=src/app/sub/handler.py
from ..billing import charge

charge.charge()
```

## Expect

- src/app/sub/handler.py:1 -> node:billing      # two dots climb one parent → app/billing/{__init__,charge}.py (node billing)

## Why

The parent-relative climb is a fixed count of `dirname` steps anchored to the importer's
position, so it resolves to exactly one in-repo package — no `sys.path` search, no
ambiguity, no room to mis-root.
