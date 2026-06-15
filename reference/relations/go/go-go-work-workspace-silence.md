---
id: go-go-work-workspace-silence
language: go
category: import
expectation: silence
cites: "go.dev/ref/mod — Workspaces / go.work / use directive (workspaces select main modules; do NOT change path→directory resolution); research F5"
---

## Rule

A `go.work` workspace with `use (./a ./b)` lets a file in module `a` import module
`b`'s packages by `b`'s OWN module path. But `go.work` adds no new import-path
syntax — resolution stays module-path + subdirectory. From the importing file the
nearest go.mod is module `a`, and `example.com/b/lib` does not start with the `a`
prefix, so the gate does not fire → silence. The analyzer reads no `go.work` file.
Missing this cross-workspace edge is a tolerated false-NEGATIVE.

## Files

```go path=ws/go.work
go 1.21

use (
  ./a
  ./b
)
```

```go path=ws/a/go.mod
module example.com/a
```

```go path=ws/b/go.mod
module example.com/b
```

```go path=ws/b/lib/lib.go
package lib
func Use() {}
```

```go path=ws/a/app/main.go
package main
import "example.com/b/lib"
func main() { lib.Use() }
```

## Expect

- silence      # from module `a`'s go.mod, `example.com/b/lib` is a different module → gate fails → no edge (go.work unmodeled)

## Why

`go.work` selects which modules are "main" for version selection but does not change
the fundamental path→directory rule, so it introduces no new naming form to detect;
the cross-module edge is silenced exactly like any other out-of-module import.
