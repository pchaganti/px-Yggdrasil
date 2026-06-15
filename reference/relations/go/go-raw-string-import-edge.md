---
id: go-raw-string-import-edge
language: go
category: import
expectation: edge
cites: "Go spec — Import declarations (`ImportPath = string_lit`; raw and interpreted string literals); research A1 (raw-string variant)"
---

## Rule

An import path is a `string_lit`, which may be a raw (backtick-quoted) string
literal as well as the usual interpreted (double-quoted) one. The extractor strips
the surrounding delimiter for either kind, so a backtick-quoted import path resolves
to exactly the same package directory as its double-quoted equivalent — one edge to
the path it names.

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
import `example.com/m/billing`
func main() { billing.Charge() }
```

## Expect

- m/app/main.go:2 -> node:billing      # the raw-string path `example.com/m/billing` strips to dir billing/ (node billing)

## Why

The delimiter form (interpreted vs raw) is irrelevant to the path; both yield the
identical specifier, so the edge is identical.
