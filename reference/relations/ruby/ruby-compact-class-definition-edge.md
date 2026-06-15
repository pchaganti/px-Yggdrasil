---
id: ruby-compact-class-definition-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby — compact class/module definition `class Foo::Bar` https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART D §D2"
---

## Rule

A compact definition `class Registry::Entry` has a `scope_resolution` name field; it
DEFINES the FQN `Registry::Entry` verbatim (and the scoped name is the name field, so it
is never a use of itself). A consumer that references `Registry::Entry` as a value resolves
through the SymbolTable to that one defining file — the edge. The compact form REOPENS the
`Registry` namespace, which must pre-exist; here it is anchored in-repo by a bare `module
Registry`, so `Registry` is genuinely an in-repo namespace and `Registry::Entry` resolves.
(A compact definition whose ROOT is NOT anchored in-repo is reopening an EXTERNAL library
and does not resolve — see ruby-reopened-external-constant-silence.)

## Files

```ruby path=src/registry/registry.rb
module Registry
end
```

```ruby path=src/registry/entries.rb
class Registry::Entry
end
```

```ruby path=src/consumer/lookup.rb
x = Registry::Entry
```

## Expect

- src/consumer/lookup.rb:1 -> node:registry      # `class Registry::Entry` defines FQN Registry::Entry (root Registry anchored by `module Registry`); the consumer's use resolves to node registry

## Why

The scoped name is the FQN supply for the table; a consumer use keys on the same verbatim
FQN, so the compact definition is correctly the edge target — provided its root namespace
is anchored in-repo (a bare `module Registry`), confirming `Registry` is not external.
