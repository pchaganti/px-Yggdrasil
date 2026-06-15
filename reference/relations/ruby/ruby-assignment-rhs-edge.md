---
id: ruby-assignment-rhs-edge
language: ruby
category: usage-site
expectation: edge
cites: "Ruby — Constants / Assignment https://docs.ruby-lang.org/en/3.4/syntax/assignment_rdoc.html#label-Constants ; research PART D §D3"
---

## Rule

A top-level `MyAlias = OriginalClass` DEFINES the constant `MyAlias` (the LHS is a
definition indexed in the table) AND the RHS constant `OriginalClass` is a USE reached
by generic descent. The LHS `MyAlias` resolves to its OWN file (same node) so it is no
cross-node edge; the RHS `OriginalClass`, uniquely defined in node `legacy`, is the
edge.

## Files

```ruby path=src/legacy/original_class.rb
class OriginalClass
end
```

```ruby path=src/aliases/alias_def.rb
MyAlias = OriginalClass
```

## Expect

- src/aliases/alias_def.rb:1 -> node:legacy      # assignment RHS `OriginalClass` is a use (LHS `MyAlias` defines, resolves to own node → no self-edge)

## Why

declarations() treats the assignment LHS as a definition (no self-edge), while uses()
reaches the RHS by generic descent — the asymmetry is by design, so exactly the RHS
dependency is emitted.
