---
id: python-from-import-absolute-edge
language: python
category: import
expectation: edge
cites: "Python import system — Submodules (`from a.b import c` searches the submodule then the attribute); Language Reference §7.11; research 2026-06-15 PART B §B1"
---

## Rule

`from M import x` absolute emits BOTH the module `M` and the longest-match submodule
candidate `M.x`. Here `x` is a NAME (a function) defined inside `billing/charge.py`, not
a submodule file, so `billing.charge.Charge` finds no `billing/charge/Charge.py` and
falls back to the parent module file `billing/charge.py` — NEVER an invented phantom
`billing/charge/Charge.py`. The base `billing.charge` resolves to the same file, so both
specifiers collapse to ONE logical edge (deduped by file → node).

## Files

```python path=src/billing/charge.py
def Charge():
    pass
```

```python path=src/app/main.py
from billing.charge import Charge

Charge()
```

## Expect

- src/app/main.py:1 -> node:billing      # both `billing.charge` and `billing.charge.Charge` resolve to billing/charge.py (node billing) → one edge

## Why

The submodule-vs-name ambiguity is the single most Python-specific FP risk; longest-match
with parent fallback never manufactures a child file, so a name-in-module resolves to the
file that actually defines it, never a phantom.
