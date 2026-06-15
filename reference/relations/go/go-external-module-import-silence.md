---
id: go-external-module-import-silence
language: go
category: import
expectation: silence
cites: "go.dev/ref/mod (the go command resolves package paths under their module prefix); research B5"
---

## Rule

An import path belonging to a DIFFERENT module (`github.com/gorilla/mux`,
`golang.org/x/tools/...`) does not start with the repo's module prefix, so the gate
rejects it. External-module source lives in the module cache, never in the repo, so
there is no in-repo directory to point at → silence.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/app/main.go
package main
import "github.com/gorilla/mux"
func main() { _ = mux.NewRouter }
```

## Expect

- silence      # `github.com/gorilla/mux` is a different module, not under `example.com/m` → no edge

## Why

Only imports under the repo's own module are graph-resolvable; any in-repo directory
that coincidentally shares a leaf with an external path must not be chosen — the
module-prefix gate, not a directory scan, is the guard.
