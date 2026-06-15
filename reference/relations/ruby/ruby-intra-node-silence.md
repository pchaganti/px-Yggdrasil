---
id: ruby-intra-node-silence
language: ruby
category: usage-site
expectation: silence
cites: "Ruby Kernel#require_relative + Modules and Classes (same-node reference) https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research — intra-node / ancestor references are not cross-node edges"
---

## Rule

A reference whose resolved target maps to the SAME node as the referrer is not a
cross-node dependency — there is nothing to declare. A `require_relative './base'` to a
sibling file in the same directory resolves to a file owned by the same node, and a
superclass `class Order < Base` whose `Base` is defined in that same-node sibling
likewise resolves within the node. Both a same-node path link and a same-node symbol
reference (whether the definition lives in a sibling or an ancestor file of the same
node) collapse to no edge: the pass only emits when the resolved owner differs from the
referrer's node.

## Files

```ruby path=src/orders/base.rb
class Base
end
```

```ruby path=src/orders/order.rb
require_relative './base'
class Order < Base
end
```

## Expect

- silence      # `require_relative './base'` and `class Order < Base` both resolve inside node `orders` → same node → no cross-node edge

## Why

A dependency confined to one node (sibling or ancestor file) is intra-node by
construction; the resolver yields the referrer's own node, which the pass filters out,
so no relation is required.
