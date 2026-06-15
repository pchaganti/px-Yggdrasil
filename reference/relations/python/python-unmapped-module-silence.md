---
id: python-unmapped-module-silence
language: python
category: import
expectation: silence
cites: "Python import system — resolution probes a SPECIFIC file (an import to a directory carrying no mapped source has no representative file); research 2026-06-15 §PY7 (resolution miss / coverage gap)"
---

## Rule

An import resolves only when its module FILE is present and mapped to a node. An import
pointing at a module whose file carries no mapped source — an uncovered module, owned by
no node — has no file to point at, so the file probe returns nothing → silence. A
dependency on an unmapped target is a coverage matter, never a relation error: no edge is
emitted. Here `import warehouse.stock` names a module with no file in the project, while a
real `billing/charge.py` is present to show the resolver is not mis-rooting.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
import warehouse.stock
```

## Expect

- silence      # `warehouse.stock` maps to no file under any source root → no node → no edge

## Why

Pointing an edge at a module the graph does not cover would manufacture a target; the
resolver requires a real, present file, so an uncovered module is silently a recall gap,
never a false positive.
