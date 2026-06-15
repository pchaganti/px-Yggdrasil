---
id: php-multi-clause-use-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A7 multi-clause import); research 2026-06-15 PART A §A7"
---

## Rule

A single `use` statement may carry comma-separated clauses, each its own import with
its own optional `as` alias. `use App\A\Alpha as X, App\B\Beta as Y;` is two imports:
edges `App\A\Alpha` and `App\B\Beta`, with the aliases `X`/`Y` as local bindings only.
Stopping at the first clause loses the second; emitting an alias is a false positive.

## Files

```php path=src/A/Alpha.php
<?php
namespace App\A;
class Alpha {}
```

```php path=src/B/Beta.php
<?php
namespace App\B;
class Beta {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\A\Alpha as X, App\B\Beta as Y;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:A      # first clause `App\A\Alpha` → src/A/Alpha.php (node A); alias `X` is never a target
- src/Order/Handler.php:3 -> node:B      # second clause `App\B\Beta` → src/B/Beta.php (node B); alias `Y` is never a target

## Why

Each comma-separated clause is its own import on its own merit; both resolve, neither
alias is the target.
