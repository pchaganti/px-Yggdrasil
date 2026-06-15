---
id: ruby-superclass-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Modules and Classes (inheritance `<`) https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html#label-Inheritance ; research PART B §B1"
---

## Rule

`class C < Base` names `Base` as the superclass — a constant reference resolved
through the shared SymbolTable by its lexically-built FQN. At top level (no enclosing
namespace) the bare `Base` is shadow-free, so it is emitted. When the FQN has exactly
one mapped definition the edge resolves; the class's OWN name (`C`) is a definition,
never a use. Here `BaseService` is uniquely defined in node `base`, so
`class OrderService < BaseService` depends on node `base`.

## Files

```ruby path=src/base/base_service.rb
class BaseService
end
```

```ruby path=src/orders/order_service.rb
class OrderService < BaseService
end
```

## Expect

- src/orders/order_service.rb:1 -> node:base      # superclass `BaseService` resolves to its one defining file (node base)

## Why

Full-FQN keying plus the unique-or-silence guard make this the safe direction: a
same-leaf `BaseService` in a second file would be ambiguous → silence, never a guess.
