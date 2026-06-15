---
id: go-single-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (`ImportSpec = [ \".\" | PackageName ] ImportPath`); go.dev/ref/mod (package path = module path + subdirectory); research A1/B1"
---

## Rule

A single `import "path"` declaration is the only edge-bearing Go form. The operand
is the import PATH (a string literal); resolution strips the go.mod `module` prefix
to a repo-relative package DIRECTORY, then picks a representative `.go` file in
exactly that directory. So `import "example.com/m/billing"` under module
`example.com/m` resolves to the directory `billing/` (node `billing`) — a real
cross-package dependency, keyed on the full path, never on the last segment alone.

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
import "example.com/m/billing"
func main() { billing.Charge() }
```

## Expect

- m/app/main.go:2 -> node:billing      # `import "example.com/m/billing"` strips the module prefix → dir billing/ (node billing)

## Why

The full import path pins exactly one package directory; the module-prefix gate plus
full-path keying make this the safe direction — a same-leaf directory elsewhere is
reached only by its own full path, never mis-chosen.
