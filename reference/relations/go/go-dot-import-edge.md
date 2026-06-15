---
id: go-dot-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (dot import merges exported names into the file block); research A4"
---

## Rule

A dot import `import . "path"` merges the package's exported identifiers into the
importing file's block (used unqualified). The `.` changes only how the names are
spelled locally; it is a genuine, mandatory dependency on that package directory.
The edge is to the import PATH.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/dsl/builder.go
package dsl
func Build() {}
```

```go path=m/app/main.go
package main
import . "example.com/m/dsl"
func main() { Build() }
```

## Expect

- m/app/main.go:2 -> node:dsl      # dot import is a real dependency on dir dsl/ (node dsl); `.` binding is irrelevant

## Why

Treating the `.` binding as "no real dependency" would miss a true edge — the
package's exported names are used unqualified. The path alone establishes it.
