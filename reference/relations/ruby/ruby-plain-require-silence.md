---
id: ruby-plain-require-silence
language: ruby
category: import
expectation: silence
cites: "Ruby Kernel#require (`$LOAD_PATH` search, not file-relative) https://docs.ruby-lang.org/en/3.4/Kernel.html#method-i-require ; research PART A §A3"
---

## Rule

`require 'x'` / `require 'x/y'` is resolved against the `$LOAD_PATH` (gems, activated
gem `lib/`, `-I` dirs) — NOT relative to the requiring file. A source-only tool cannot
replay the load-path search without Bundler, so it must not guess. The extractor
matches ONLY the method name `require_relative`; a plain `require` is never emitted as
a path hint, even when a same-named file happens to exist in the repo.

## Files

```ruby path=src/jsonlib/json.rb
module JSON
end
```

```ruby path=src/app/loader.rb
require 'json'
require 'order/processor'
```

## Expect

- silence      # plain `require` is load-path-resolved, never a path hint — the coincidental src/jsonlib/json.rb is not bound

## Why

Treating `require 'json'` as `./json.rb` would fabricate an edge whenever a same-named
in-repo file coincidentally exists; the method-name gate closes that FP.
