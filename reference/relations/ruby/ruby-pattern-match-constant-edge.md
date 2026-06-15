---
id: ruby-pattern-match-constant-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Pattern matching `case/in` (3.0) https://docs.ruby-lang.org/en/3.4/syntax/pattern_matching_rdoc.html ; research PART F §F1"
---

## Rule

A pattern may name a constant for a type/deconstruct match (`in Errors::NotFound`).
The constant in a pattern is an ordinary `constant`/`scope_resolution` node reached by
generic descent — the SAME resolveUnique/C1 handling as any value-use constant. No new
naming axis: a qualified pattern constant at top level emits and resolves to its one
defining file.

## Files

```ruby path=src/errors/not_found.rb
module Errors
  class NotFound
  end
end
```

```ruby path=src/handler/dispatch.rb
case x
in Errors::NotFound
  handle
end
```

## Expect

- src/handler/dispatch.rb:2 -> node:errors      # pattern constant `Errors::NotFound` is a constant ref (generic descent) → node errors

## Why

Pattern matching added no new cross-file naming form; a pattern constant is a constant
reference like any other, so it resolves through the same unique-or-silence path.
