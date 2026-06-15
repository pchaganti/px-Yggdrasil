---
id: php-trap-trait-use-relative-import-edge
language: php
category: trap
expectation: edge
cites: "php.net language.oop5.traits (top-level use absolute vs in-class use relative); research 2026-06-15 trap T6"
---

## Rule

`namespace Foo\Bar; use Baz\Trait1; class C { use Trait1; use Foo\Trait2; }` — the
top-level `use Baz\Trait1;` is an absolute class/trait IMPORT → edge `Baz\Trait1`. The
in-class trait `use Trait1;` (→ `Foo\Bar\Trait1`) and `use Foo\Trait2;` (→
`Foo\Bar\Foo\Trait2`, current-ns relative, never `\Foo\Trait2`) are usage-site and
silent. The two `use` operators differ: the top-level namespace `use` is absolute, the
in-class trait `use` is namespace-relative.

## Files

```php path=lib/Pkg/Trait1.php
<?php
namespace Baz;
trait Trait1 {}
```

```php path=src/Bar/C.php
<?php
namespace Foo\Bar;
use Baz\Trait1;
class C { use Trait1; use Foo\Trait2; }
```

```json path=composer.json
{ "autoload": { "psr-4": { "Baz\\": "lib/Pkg/", "App\\": "src/" } } }
```

## Expect

- src/Bar/C.php:3 -> node:Pkg      # top-level `use Baz\Trait1;` resolves to lib/Pkg/Trait1.php (node Pkg); the in-class trait uses are relative and silent

## Why

Only the absolute top-level import edges; the in-class trait `use` is namespace-relative
and stays silent, so the relative forms can never mis-bind to a global path.
