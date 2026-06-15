---
id: ruby-lexical-shadowing-bare-silence
language: ruby
category: nested
expectation: silence
cites: "Module.nesting (lexical constant lookup) https://docs.ruby-lang.org/en/3.4/Module.html#method-c-nesting ; research PART C §C4 (C1 guard)"
---

## Rule

Inside any class/module body a BARE unqualified constant lexically resolves against the
enclosing namespace FIRST — a bare `Helper` inside `class Order` may mean
`Order::Helper`, not a top-level `Helper` owned by another node. A source-only tool
cannot disambiguate, so a bare constant nested in a namespace is SUPPRESSED (C1) — it
is not even emitted. Only a `::`-rooted or `::`-qualified reference (shadow-free) emits
inside a namespace.

## Files

```ruby path=src/helpers/helper.rb
class Helper
end
```

```ruby path=src/orders/order.rb
class Order
  def run
    Helper.go
  end
end
```

## Expect

- silence      # bare `Helper` inside `class Order` lexically shadows (could be Order::Helper) → C1-suppressed → no edge even though a top-level Helper exists

## Why

Binding the bare nested `Helper` to the top-level node's `Helper` would be a false
positive whenever an `Order::Helper` is the real target; suppression keeps recall loss,
not a false red.
