---
id: go-replace-directive-silence
language: go
category: import
expectation: silence
cites: "go.dev/ref/mod — replace directive (redirects a module path to a local path; applies only in the main module); research F4"
---

## Rule

A main-module `replace example.com/other => ./vendored/other` makes the go toolchain
resolve `example.com/other/pkg` to the in-repo directory `vendored/other/pkg/`. The
resolver reads ONLY the `module` line of go.mod (a line-oriented `module <path>`
reader), never the `replace` directives, so the imported path is gated as external:
it does not start with the repo's module prefix → silence. Missing this genuine
in-tree edge is a tolerated false-NEGATIVE — it can never mis-bind to a wrong
directory, because the redirect is simply not performed.

## Files

```go path=m/go.mod
module example.com/m

replace example.com/other => ./vendored/other
```

```go path=m/vendored/other/pkg.go
package other
func Helper() {}
```

```go path=m/app/main.go
package main
import "example.com/other"
func main() { other.Helper() }
```

## Expect

- silence      # `example.com/other` is not under module `example.com/m`; the `replace` redirect is unmodeled → no edge

## Why

Modeling `replace` would require parsing the full replace graph; the line-oriented
`module`-only reader deliberately does not, trading recall for the same zero-FP
guarantee as every other unmodeled rewrite — silence over a guessed edge.
