---
id: ruby-reopening-ambiguity-silence
language: ruby
category: trap
expectation: silence
cites: "Ruby — reopening / open classes https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART D §D6 (the central recall-killer)"
---

## Rule

`class Foo … end` in two files both REOPEN/define `Foo` — indistinguishable at the AST
level from one definition plus one monkey-patch. The extractor records BOTH (no
dedupe); the SymbolTable then has 2 files for `Foo` → `resolveUnique` returns undefined
→ any use of `Foo` is SILENCED. Picking either owner would fabricate one edge and hide
the other — a textbook false positive — so an ambiguous constant emits nothing.

## Files

```ruby path=src/x/widget.rb
class Widget
end
```

```ruby path=src/y/widget.rb
class Widget
end
```

```ruby path=src/z/use.rb
x = Widget
```

## Expect

- silence      # `Widget` is defined in two files → ambiguous → resolveUnique undefined → no edge (never an arbitrary pick)

## Why

An open-classes language must treat a reopened constant as having no single owning
file; silencing is the mandatory zero-FP behaviour, not a guess between the two nodes.
