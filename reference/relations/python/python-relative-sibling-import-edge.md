---
id: python-relative-sibling-import-edge
language: python
category: import
expectation: edge
cites: "PEP 328 — a single leading dot is a relative import starting with the current package; Python import system — Package relative imports; research 2026-06-15 PART C §C1/§C2"
---

## Rule

`from .sub import x` (one dot + tail) names a subpackage within the importing file's own
package, resolved by pinning the directory to the importer's package and appending the
tail. From `src/orders/handler.py`, `from .pay import charge` emits `.pay` (→
`src/orders/pay/__init__.py`) and `.pay.charge` (→ `src/orders/pay/charge.py`). Both files
live under `pay/`, node `pay` — a cross-node edge from node `orders`. The relative join
PINS the directory, so a same-basename `pay/` elsewhere is structurally unreachable.

## Files

```python path=src/orders/pay/__init__.py
pass
```

```python path=src/orders/pay/charge.py
def charge():
    pass
```

```python path=src/orders/handler.py
from .pay import charge

charge.charge()
```

## Expect

- src/orders/handler.py:1 -> node:pay      # `.pay` → orders/pay/__init__.py and `.pay.charge` → orders/pay/charge.py, both node pay → one edge

## Why

A relative import is directory-pinned to the importer's package, so it can only reach a
subpackage actually nested under it — a same-named directory in another tree can never be
chosen, making the relative form one of the safest edges.
