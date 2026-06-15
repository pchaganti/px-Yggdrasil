---
id: go-grouped-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (parenthesized ImportSpec list); research A2/B1"
---

## Rule

A parenthesized `import ( … )` block holds N independent `import_spec` children;
each is its own dependency, resolved by its own full path. Two in-module imports in
one block produce one edge each, to the directory each path names.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/billing/charge.go
package billing
func Charge() {}
```

```go path=m/audit/log.go
package audit
func Log() {}
```

```go path=m/app/main.go
package main
import (
  "example.com/m/billing"
  "example.com/m/audit"
)
func main() { billing.Charge(); audit.Log() }
```

## Expect

- m/app/main.go:3 -> node:billing      # `"example.com/m/billing"` → dir billing/ (node billing)
- m/app/main.go:4 -> node:audit        # `"example.com/m/audit"` → dir audit/ (node audit)

## Why

Each `import_spec` is its own edge; the grouped form emits exactly the set of
in-module paths it lists, each resolved to its own directory.
