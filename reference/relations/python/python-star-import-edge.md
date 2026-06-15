---
id: python-star-import-edge
language: python
category: import
expectation: edge
cites: "Python Language Reference §7.11 — `from M import *` binds all public names (`__all__` if defined, else every non-underscore top-level name); research 2026-06-15 PART E §E1"
---

## Rule

`from pkg import *` (`wildcard_import`) is an EDGE on the module, SILENCE on the symbols.
The star-bound names are `__all__` if defined, else every non-underscore top-level name —
neither is statically enumerable without executing the module — but the dependency on the
MODULE `pkg` itself is unambiguous. The extractor emits ONE specifier `billing` (no
`billing.*`, no enumerated symbols) → `billing/__init__.py`, node `billing`.

## Files

```python path=src/billing/__init__.py
def charge():
    pass
```

```python path=src/app/main.py
from billing import *

charge()
```

## Expect

- src/app/main.py:1 -> node:billing      # the star binds the module `billing` → billing/__init__.py; the symbols are not widened

## Why

The star is a binding effect, not a target; emitting the real module edge while never
widening to a phantom `billing.*` symbol keeps the dependency true and zero-FP.
