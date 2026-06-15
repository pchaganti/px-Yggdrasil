---
id: ruby-mixin-include-extend-prepend-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby Module#include / Object#extend / Module#prepend https://docs.ruby-lang.org/en/3.4/Module.html#method-i-include ; research PART B §B4"
---

## Rule

`include` / `extend` / `prepend Mod` each name one or more modules to mix in; the
argument is a constant reference. The extractor emits one symbol per constant
argument, gated on the OUTER depth of the enclosing class/module (a top-level class
body is outer-depth 0 → emit). A qualified argument (`Tracing::Hook`) is a complete
reference and emits at any depth. Each module resolves through the SymbolTable to its
one defining file.

## Files

```ruby path=src/loggable/loggable.rb
module Loggable
end
```

```ruby path=src/forward/forwardable.rb
module Forwardable
end
```

```ruby path=src/tracing/hook.rb
module Tracing
  module Hook
  end
end
```

```ruby path=src/widgets/widget.rb
class Widget
  include Loggable
  extend Forwardable
  prepend Tracing::Hook
end
```

## Expect

- src/widgets/widget.rb:2 -> node:loggable      # `include Loggable` → node loggable
- src/widgets/widget.rb:3 -> node:forward       # `extend Forwardable` → node forward
- src/widgets/widget.rb:4 -> node:tracing       # `prepend Tracing::Hook` → FQN Tracing::Hook (node tracing)

## Why

A mixin argument is a genuine code dependency on the module's defining file; one edge
per uniquely-defined mapped module, each keyed on its verbatim FQN.
