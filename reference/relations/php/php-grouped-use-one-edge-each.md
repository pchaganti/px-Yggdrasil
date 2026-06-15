---
id: php-grouped-use-one-edge-each
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A4 grouped import); research 2026-06-15 PART A §A4"
---

## Rule

A grouped `use App\Payment\{Charge\Card, Refund\Cash};` is sugar for the individual
imports `use App\Payment\Charge\Card;` and `use App\Payment\Refund\Cash;`. The leading
base namespace is prepended to each clause, so each clause is its own per-type edge to
its own resolved file. Forgetting the base would emit a bare clause that fails PSR-4
resolution; dropping a clause would lose its edge.

## Files

```php path=src/Payment/Charge/Card.php
<?php
namespace App\Payment\Charge;
class Card {}
```

```php path=src/Payment/Refund/Cash.php
<?php
namespace App\Payment\Refund;
class Cash {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Payment\{Charge\Card, Refund\Cash};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Charge      # base + `Charge\Card` = `App\Payment\Charge\Card` → src/Payment/Charge/Card.php (node Charge)
- src/Order/Handler.php:3 -> node:Refund      # base + `Refund\Cash` = `App\Payment\Refund\Cash` → src/Payment/Refund/Cash.php (node Refund)

## Why

Each group clause is its own import; the base namespace is prepended to each, so a
group of N classes is N independent edges to N distinct files, never one aggregate.
