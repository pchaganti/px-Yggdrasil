---
id: go-aliased-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (explicit PackageName renames the local binding only); research A3"
---

## Rule

An aliased import `import alias "path"` renames only the LOCAL binding used in
qualified identifiers; it does not change the package depended on. The extractor
reads only the `path` field, never the `name` (alias) field, so the edge is to the
import PATH — the alias token is never a target.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/billing/charge.go
package billing
func Charge() {}
```

```go path=m/app/main.go
package main
import pay "example.com/m/billing"
func main() { pay.Charge() }
```

## Expect

- m/app/main.go:2 -> node:billing      # the PATH `example.com/m/billing` is the edge; alias `pay` is never a target

## Why

The local binding (`pay`) is irrelevant to the dependency; every binding form names
the same real package path, so resolution keys on the path alone.
