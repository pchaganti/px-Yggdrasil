---
id: ruby-rooted-constant-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby — `::Top` absolute scope https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART B §B2 / PART C §C5"
---

## Rule

A `::`-rooted reference (`< ::Top::Base`) is ABSOLUTE — shadow-free even inside a
namespace. `.text` preserves the `::`; the extractor strips a single leading `::` so
the key `Top::Base` matches a definition recorded without the leading `::`. The rooted
superclass resolves through the SymbolTable to its one defining file regardless of
depth. Here `Top::Base` is uniquely defined in node `toplib`.

## Files

```ruby path=src/toplib/base.rb
module Top
  class Base
  end
end
```

```ruby path=src/orders/service.rb
class Service < ::Top::Base
end
```

## Expect

- src/orders/service.rb:1 -> node:toplib      # rooted `::Top::Base` → leading `::` stripped → key Top::Base (node toplib)

## Why

A `::`-rooted path is unambiguously absolute, so emitting it (even as a nested
superclass) is safe; the `::` strip aligns the use key with the definition key.
