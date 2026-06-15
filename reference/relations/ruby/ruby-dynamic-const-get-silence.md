---
id: ruby-dynamic-const-get-silence
language: ruby
category: dynamic
expectation: silence
cites: "Ruby Module#const_get https://docs.ruby-lang.org/en/3.4/Module.html#method-i-const_get ; Module#autoload https://docs.ruby-lang.org/en/3.4/Module.html#method-i-autoload ; research PART E §E1/E3"
---

## Rule

Metaprogramming and autoload route a constant through a mechanism a source-only tool
cannot resolve. `const_get`/`send`/`constantize` take a String/Symbol naming the
constant at runtime — a `string`/`simple_symbol` node, NEVER a `constant` node — so the
dynamic target is never emitted. The receiver `Object` IS a constant but is stdlib →
unmapped → silenced. `autoload :Sym, 'path'` likewise has a `simple_symbol` first arg
(not a constant) and a `$LOAD_PATH`-relative path (a `require`, not `require_relative`),
so neither axis emits — even though the target class is defined in a mapped file.

## Files

```ruby path=src/registry/widget.rb
class Widget
end
```

```ruby path=src/app/dynamic.rb
obj = Object.const_get('Widget')
autoload :Widget, 'widget'
```

## Expect

- silence      # the dynamic string 'Widget' / symbol :Widget are never `constant` nodes; the `Object` receiver is unmapped stdlib → no edge

## Why

Parsing the dynamic string and binding it as a constant would re-introduce a name-guess
false positive; the AST symbol-vs-string distinction keeps it silent by construction.
