---
id: go-stdlib-import-silence
language: go
category: builtin
expectation: silence
cites: "go.dev/ref/mod (module path is the prefix for in-module package paths); research B4"
---

## Rule

A standard-library import path (`fmt`, `os`, `strings`) does not begin with the
repo's module path, so the module-prefix gate rejects it — its source lives in the
toolchain, not the repo. The extractor still emits the specifier (it cannot know it
is stdlib); the resolver silences it because it is neither the module path nor under
`<module>/`.

## Files

```go path=m/go.mod
module example.com/m
```

```go path=m/app/main.go
package main
import "fmt"
func main() { fmt.Println("hi") }
```

## Expect

- silence      # `fmt` is not under module `example.com/m` → no in-repo directory → no edge

## Why

The module-prefix gate is the single most important false-positive guard: mis-rooting
`fmt` to a coincidental in-repo `fmt/` directory would be a false positive — the gate
prevents it by requiring the import to be under the repo's own module.
