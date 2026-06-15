---
id: python-all-export-silence
language: python
category: usage-site
expectation: silence
cites: "Python tutorial — `__all__` is the star-export list (an assignment statement, not an import); research 2026-06-15 PART E §E2"
---

## Rule

`__all__ = ['x', 'y']` is an ASSIGNMENT statement (an `expression_statement`), not an
import. It constrains which names a `from pkg import *` binds, but it names no module
dependency itself, and the strings it lists are SYMBOLS already defined in the module, not
module paths. The extractor never visits it as an edge node, so it emits nothing — even
though `'charge'` looks like it could name a module, it is just a string in a list.

## Files

```python path=src/billing/__init__.py
def charge():
    pass


def refund():
    pass


__all__ = ["charge", "refund"]
```

## Expect

- silence      # `__all__ = [...]` is an assignment, not an import → no edge; the listed strings are local symbols, never module paths

## Why

`__all__` modulates a star import's bindings but is not itself an import; resolving its
string entries back to a source would require name-axis tracing the path-axis design
forbids, so it correctly emits nothing.
