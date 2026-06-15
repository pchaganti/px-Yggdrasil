---
id: ruby-external-stdlib-constant-silence
language: ruby
category: builtin
expectation: silence
cites: "Ruby — Constants / constant lookup https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART E §E6 / resolution algorithm (0 defs → absent)"
---

## Rule

A constant that names a gem or core/stdlib type (`Math::PI`, `StandardError`) is
emitted as an ordinary symbol use, but the SymbolTable has ZERO in-graph definitions
for it → the symbol axis classifies it `absent` → silence. An external constant has no
mapped defining file to point at, so no edge is manufactured.

## Files

```ruby path=src/app/calculator.rb
x = Math::PI
y = StandardError
```

## Expect

- silence      # `Math::PI` and `StandardError` have no in-graph definition → absent → no edge (a coverage non-event)

## Why

The resolver requires a real mapped definition; an external/stdlib constant simply has
none, so it is a silent recall non-event, never a false positive.
