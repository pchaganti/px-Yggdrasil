---
id: python-dynamic-importlib-silence
language: python
category: dynamic
expectation: silence
cites: "importlib.import_module / __import__ — dynamic imports take a runtime STRING argument (no import statement node); research 2026-06-15 PART E §E5"
---

## Rule

`importlib.import_module("a.b")` and `__import__("x")` are FUNCTION CALLS whose argument
is a runtime string — there is no `import_statement` / `import_from_statement` node, and
the string literal is never read. The target may be computed
(`import_module(f"plugins.{n}")`), so emitting any edge from the argument would be a
guess = an FP. The only import node here is `import importlib` (stdlib → resolution miss →
silent); the dynamic call contributes nothing, even though a real `billing/charge.py`
exists in the fixture.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/app/main.py
import importlib

m = importlib.import_module("billing.charge")
m.charge()
```

## Expect

- silence      # the string "billing.charge" is never an edge; `import importlib` is stdlib → no in-repo file → no edge

## Why

Reading the string literal and emitting `billing.charge` would be an unjustified guess
that is wrong for any computed argument; silence is mandatory for dynamic imports.
