---
id: ruby-unmapped-target-silence
language: ruby
category: import
expectation: silence
cites: "Ruby Kernel#require_relative (resolution miss → undefined) https://docs.ruby-lang.org/en/3.4/Kernel.html#method-i-require_relative ; research PART A §A6 / resolution algorithm (unmapped → absent)"
---

## Rule

A `require_relative` whose normalized target does not exist in the resolution universe
yields undefined (fail-to-silence IS the false-positive guard), and a bare constant
that no in-graph file defines is `absent` on the symbol axis. Either way there is no
mapped target to point at, so no edge is emitted. A dependency on an unmapped/absent
target is a coverage matter, never a relation error.

## Files

```ruby path=src/app/main.rb
require_relative '../missing/gone'
x = NotDefinedAnywhere
```

## Expect

- silence      # require_relative target does not exist → undefined; `NotDefinedAnywhere` has no definition → absent → no edge

## Why

Pointing an edge at a file the graph does not cover would manufacture a target; the
resolver requires a real, mapped resolution, so an unmapped target is silently a recall
gap, never a false red.
