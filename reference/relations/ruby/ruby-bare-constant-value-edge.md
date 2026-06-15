---
id: ruby-bare-constant-value-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Constants https://docs.ruby-lang.org/en/3.4/syntax/assignment_rdoc.html#label-Constants ; research PART C §C1"
---

## Rule

A bare constant used as a value (`x = Helper`) is a constant reference. At TOP LEVEL
there is no enclosing namespace to shadow it, so the bare name is taken as the FQN key
and emitted. When that key has exactly one mapped definition the edge resolves. Here
`Helper` is uniquely defined in node `helpers`.

## Files

```ruby path=src/helpers/helper.rb
class Helper
end
```

```ruby path=src/app/runner.rb
x = Helper
```

## Expect

- src/app/runner.rb:1 -> node:helpers      # top-level bare `Helper` (no enclosing namespace) → node helpers

## Why

A bare constant emits ONLY at top level (no namespace to shadow it); nested it would
be suppressed (C1). The unique-or-silence guard still protects the resolved edge.
