---
id: php-grouped-mixed-const-class-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A10 per-clause const guard); research 2026-06-15 PART A §A10"
---

## Rule

A grouped use may carry the `const` keyword on an INDIVIDUAL clause:
`use App\Pkg\{const MAX, Gateway};`. Only that clause is a constant import (no class
edge); sibling CLASS clauses still import classes. Dropping the whole group on seeing
one `const` keyword would lose the sibling class edge; emitting `MAX` as a class would
be a false positive.

## Files

```php path=src/Pkg/Gateway.php
<?php
namespace App\Pkg;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Pkg\{const MAX, Gateway};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Pkg      # only the class clause `App\Pkg\Gateway` resolves to src/Pkg/Gateway.php (node Pkg); the `const MAX` clause is silent

## Why

The per-clause keyword drops only its own clause; the sibling class clause is a real
import edge, so a mixed group emits exactly the class clauses.
