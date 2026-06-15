---
id: go-intra-package-silence
language: go
category: usage-site
expectation: silence
cites: "Go spec — Package clause (a set of files sharing the same PackageName form one package) / Declarations and scope; research E1/E2 (intra-package references need no import)"
---

## Rule

Files in the same directory share one package; a reference to a name declared in a
sibling file of the same package needs NO import (the names are in the package
block). With no `import_spec`, the import-only extractor emits nothing — and the two
files map to the SAME node anyway, so even a detected reference would be intra-node,
never a cross-node edge. Intra-package references are silent.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/billing/charge.go
package billing
func Charge() { receipt() }
```

```go path=m/billing/receipt.go
package billing
func receipt() {}
```

## Expect

- silence      # `charge.go` calls `receipt()` from a sibling file in the same package — no import, same node → no edge

## Why

Go establishes a cross-package edge only through an import; same-package code is one
node, so an intra-package reference can never be a cross-node dependency to detect.
