---
id: php-grouped-mixed-position-independent-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A10 position-independent guard); research 2026-06-15 PART A §A10"
---

## Rule

The per-clause function/const guard is position-independent: in
`use App\Pkg\{Gateway, function format};` the class clause `Gateway` precedes the
function clause and still emits, while the `function format` clause is silent. The
guard keys off each clause's own keyword, not its position in the group.

## Files

```php path=src/Pkg/Gateway.php
<?php
namespace App\Pkg;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Pkg\{Gateway, function format};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Pkg      # class clause `App\Pkg\Gateway` emits regardless of order; the trailing `function format` clause is silent

## Why

Each clause is judged by its own keyword; a class clause edges whether it comes before
or after a function clause in the group.
