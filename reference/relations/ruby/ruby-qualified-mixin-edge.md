---
id: ruby-qualified-mixin-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby Module#include + scope resolution `::` https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART B §B5"
---

## Rule

A `::`-qualified mixin argument (`include Shared::Loggable`) is a COMPLETE reference —
it does not lexically shadow against the enclosing namespace, so it is emitted even
when nested deep inside `module App; class Widget`. The verbatim key `Shared::Loggable`
resolves through the SymbolTable to its one defining file, regardless of nesting depth.

## Files

```ruby path=src/shared/loggable.rb
module Shared
  module Loggable
  end
end
```

```ruby path=src/widgets/widget.rb
module App
  class Widget
    include Shared::Loggable
  end
end
```

## Expect

- src/widgets/widget.rb:3 -> node:shared      # qualified `Shared::Loggable` is shadow-free → emitted at depth, resolves to node shared

## Why

The qualified path is unambiguously absolute; emitting it inside a namespace is safe
(no shadowing), so a real cross-node mixin dependency is not lost to the C1 guard.
