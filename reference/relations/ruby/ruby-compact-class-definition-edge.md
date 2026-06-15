---
id: ruby-compact-class-definition-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby — compact class/module definition `class Foo::Bar` https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART D §D2"
---

## Rule

A compact definition `class Registry::Entry` has a `scope_resolution` name field; it
DEFINES the FQN `Registry::Entry` verbatim (and the scoped name is the name field, so
it is never a use of itself). A consumer that references `Registry::Entry` as a value
resolves through the SymbolTable to that one defining file — the edge.

## Files

```ruby path=src/registry/entries.rb
class Registry::Entry
end
```

```ruby path=src/consumer/lookup.rb
x = Registry::Entry
```

## Expect

- src/consumer/lookup.rb:1 -> node:registry      # `class Registry::Entry` defines FQN Registry::Entry; the consumer's use resolves to node registry

## Why

The scoped name is the FQN supply for the table; a consumer use keys on the same
verbatim FQN, so the compact definition is correctly the edge target.
