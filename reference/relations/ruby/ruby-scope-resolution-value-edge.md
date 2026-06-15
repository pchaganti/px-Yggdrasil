---
id: ruby-scope-resolution-value-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Scope resolution `::` https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART C §C2"
---

## Rule

A `scope_resolution` value (`x = Payments::Gateway`) is a complete reference; `.text`
is the verbatim `A::B`. Only the full path is emitted — the inner qualifier segments
(`Payments`) are NOT each emitted, so no phantom edge to the qualifier appears. The
verbatim key `Payments::Gateway` resolves to its one defining file.

## Files

```ruby path=src/payments/gateway.rb
module Payments
  class Gateway
  end
end
```

```ruby path=src/app/charge.rb
x = Payments::Gateway
```

## Expect

- src/app/charge.rb:1 -> node:payments      # `Payments::Gateway` keyed verbatim → node payments (no edge to a bare `Payments`)

## Why

Verbatim full-FQN keying makes a same-leaf collision unreachable on the symbol axis,
and the inner-qualifier descent stops, so a long scope resolution yields exactly one edge.
