---
id: python-conditional-import-edge
language: python
category: nested
expectation: edge
cites: "Python import system — the import statement is a normal statement (both try/except branches are real static imports); research 2026-06-15 PART F §F1"
---

## Rule

A `try: import a / except ImportError: import b` contains two real static
`import_statement` nodes. CPython runs one at runtime, but the whole-tree walk sees both,
and each is a genuine potential dependency. `import billing.charge` and `import
shipping.label` each resolve to their file under the src root — two cross-node edges on
distinct lines. Over-recording relative to the single runtime path is never an FP: a
declared relation needs no code backing, and a real import is always a true dependency.

## Files

```python path=src/billing/charge.py
def charge():
    pass
```

```python path=src/shipping/label.py
def label():
    pass
```

```python path=src/app/main.py
try:
    import billing.charge
except ImportError:
    import shipping.label
```

## Expect

- src/app/main.py:2 -> node:billing       # try-branch `import billing.charge` → billing/charge.py
- src/app/main.py:4 -> node:shipping      # except-branch `import shipping.label` → shipping/label.py

## Why

The whole-tree walk catches imports at any nesting, and both branches are real static
import statements; emitting both is correct because each names a true potential
dependency, never a guess.
