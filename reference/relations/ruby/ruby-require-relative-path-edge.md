---
id: ruby-require-relative-path-edge
language: ruby
category: import
expectation: edge
cites: "Ruby Kernel#require_relative (resolved relative to the directory of the calling file; `.rb` implied) https://docs.ruby-lang.org/en/3.4/Kernel.html#method-i-require_relative ; research PART A §A1"
---

## Rule

`require_relative '<literal>'` is the ONLY file-precise static link in Ruby: the
literal is resolved relative to the DIRECTORY of the requiring file (never the load
path), with `.rb` implied. The resolver joins the literal onto `dirname(fromFile)`,
appends `.rb`, POSIX-normalizes, and checks existence. So
`require_relative '../services/order_service'` from `src/orders/order.rb` resolves to
`src/services/order_service.rb` (node `services`) — a real cross-node dependency
pinned by the call site alone.

## Files

```ruby path=src/services/order_service.rb
class OrderService
end
```

```ruby path=src/orders/order.rb
require_relative '../services/order_service'
```

## Expect

- src/orders/order.rb:1 -> node:services      # require_relative joins onto dirname(order.rb) → src/services/order_service.rb (node services)

## Why

The literal is a deterministic function of the call site's directory; a same-named
file elsewhere is reached only by its own relative literal, never mis-chosen.
