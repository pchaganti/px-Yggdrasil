---
id: php-trap-alias-matching-current-ns-edge
language: php
category: trap
expectation: edge
cites: "php.net language.namespaces.importing; language.namespaces.rules; research 2026-06-15 trap T4"
---

## Rule

`namespace foo; use blah\blah as foo;` — the import resolves to the absolute FQN
`blah\blah`, never the local alias `foo` (which happens to match the current namespace).
The per-token usage duality (`new foo()` → `foo\name` current-ns; `foo::name()` →
`blah\blah` import-wins) is usage-site and silent. The import edge is the FQN operand
verbatim; the alias coinciding with the namespace changes nothing.

## Files

```php path=lib/Pkg/blah.php
<?php
namespace blah;
class blah {}
```

```php path=src/foo/C.php
<?php
namespace foo;
use blah\blah as foo;
class C {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "blah\\": "lib/Pkg/", "App\\": "src/" } } }
```

## Expect

- src/foo/C.php:3 -> node:Pkg      # `use blah\blah as foo;` resolves to lib/Pkg/blah.php (node Pkg); the alias `foo` is never a target

## Why

The import operand is the absolute FQN regardless of the alias; an alias coinciding with
the current namespace is still just a local rename, so the edge points at the real file.
