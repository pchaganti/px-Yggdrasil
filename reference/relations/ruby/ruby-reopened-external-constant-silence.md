---
id: ruby-reopened-external-constant-silence
language: ruby
category: trap
expectation: silence
cites: "Ruby — compact `module A::B` reopens a namespace that must pre-exist; root-anchoring guard (real-repo FP: sinatra base.rb `defined?(Rackup::Handler)` mis-binding a test stub)"
---

## Rule

A compact-form declaration `module Rack::Handler` REOPENS a namespace `Rack` that must
already exist. When `Rack` has NO bare in-repo declaration (no top-level `module Rack` /
`class Rack`), it is an EXTERNAL library and the compact form merely extends it — the
declared FQN `Rack::Handler` belongs to the external gem, not to this repo. A reference to
`Rack::Handler` elsewhere therefore means the external entity, so it must NOT resolve to the
in-repo reopening (binding it would be a FALSE POSITIVE). The resolver requires a constant's
ROOT namespace to be anchored in-repo (recorded as a single-segment key); `Rack` is not, so
`Rack::Handler` does not resolve → silence. (Contrast ruby-compact-class-definition-edge,
where the root IS anchored by a bare `module`, so the compact-defined constant resolves.)

## Files

```ruby path=src/stub/server_stub.rb
module Rack::Handler
end
```

```ruby path=src/app/runner.rb
x = Rack::Handler
```

## Expect

- silence      # root `Rack` is not anchored in-repo → `Rack::Handler` is treated as external → the reference does not bind the in-repo reopening (no edge to the stub)

## Why

A test stub or monkey-patch that reopens an external gem's constant in exactly one in-repo
file must never be pulled in as the dependency target of an unrelated file that references
the SAME (external) constant. Root-anchoring keeps such reopened-external constants silent
while leaving genuinely in-repo namespaces (whose root has a bare declaration) resolvable —
zero false positives, the cardinal invariant.
