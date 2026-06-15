---
id: go-blank-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (blank-import side-effect exception) / Blank identifier; research A5"
---

## Rule

A blank import `import _ "path"` binds no name but runs the package's `init()` for
its side effects (e.g. driver registration). The spec carves it out of the
unused-import error, so it is a legitimate, real dependency on the package directory.
The binding `_` is irrelevant; the edge is to the import PATH.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/driver/register.go
package driver
func init() {}
```

```go path=m/app/main.go
package main
import _ "example.com/m/driver"
func main() {}
```

## Expect

- m/app/main.go:2 -> node:driver      # blank import is a real side-effect dependency on dir driver/ (node driver)

## Why

Treating `_` as "unused, no edge" would miss a genuine (often architecturally
important) side-effect dependency; the extractor emits the path regardless of binding.
