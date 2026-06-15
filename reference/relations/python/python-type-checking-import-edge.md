---
id: python-type-checking-import-edge
language: python
category: nested
expectation: edge
cites: "PEP 484 / typing.TYPE_CHECKING — False at runtime, True for type checkers; imports under `if TYPE_CHECKING:` are static-only; research 2026-06-15 PART F §F3"
---

## Rule

`if TYPE_CHECKING:` guards static-only imports (used in annotations, avoiding runtime cost
or circular imports). Tree-sitter parses the body as a normal block of ordinary
`import_from_statement` nodes, so the walk descends into it like any other block:
`from billing.charge import Charge` under the guard emits `billing.charge` +
`billing.charge.Charge`, both → `billing/charge.py`, a real cross-node edge. The guard
import `from typing import TYPE_CHECKING` is stdlib → resolution miss → silent, so the
only edge is to `billing`.

## Files

```python path=src/billing/charge.py
class Charge:
    pass
```

```python path=src/app/main.py
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from billing.charge import Charge
```

## Expect

- src/app/main.py:4 -> node:billing      # the guarded `from billing.charge import Charge` → billing/charge.py (node billing)

## Why

The typing guard is just an enclosing block the walk passes through; the import node is
identical to a top-level one and the dependency is real, so the guard never changes the
edge — while `typing` itself resolves to nothing in-repo and stays silent.
