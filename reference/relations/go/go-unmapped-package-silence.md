---
id: go-unmapped-package-silence
language: go
category: import
expectation: silence
cites: "go.dev/ref/mod (package path = module path + existing subdirectory); research B8 / D5 (unmapped/uncovered package)"
---

## Rule

An in-module import resolves only when its package DIRECTORY is present in the graph.
An import under the repo's own module that points at a directory carrying no mapped
`.go` source — an uncovered package, owned by no node — has no representative file to
point at, so resolution returns nothing → silence. A dependency on an unmapped target
is a coverage matter, never a relation error: no edge is emitted.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/app/main.go
package main
import "example.com/m/uncovered"
func main() {}
```

## Expect

- silence      # `example.com/m/uncovered` is under the module, but no `.go` file maps that directory → no node → no edge

## Why

Pointing an edge at a directory the graph does not cover would manufacture a target;
the resolver requires a real, mapped representative file, so an uncovered package is
silently a recall gap, never a false positive.
