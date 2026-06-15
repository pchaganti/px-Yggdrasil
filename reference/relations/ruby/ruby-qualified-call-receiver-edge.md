---
id: ruby-qualified-call-receiver-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Method calls (receiver) https://docs.ruby-lang.org/en/3.4/syntax/calling_methods_rdoc.html ; research PART C §C3"
---

## Rule

A `call` whose `receiver` field is a constant/scope_resolution
(`Payments::Gateway.charge`) references that constant — a class/module method call.
The RECEIVER is the dependency; the method name (`charge`) is not a constant. A
local-receiver call (`helper.run`, `@repo.save`) has an identifier/ivar receiver and
emits nothing. Here the receiver `Payments::Gateway` resolves to its one defining file.

## Files

```ruby path=src/payments/gateway.rb
module Payments
  class Gateway
  end
end
```

```ruby path=src/orders/handler.rb
Payments::Gateway.charge(amount)
```

## Expect

- src/orders/handler.rb:1 -> node:payments      # receiver constant `Payments::Gateway` → node payments (method name `charge` is not a constant)

## Why

Only a constant receiver is a cross-file reference; the method name and any
local-receiver call carry no symbol, so nothing spurious is emitted.
