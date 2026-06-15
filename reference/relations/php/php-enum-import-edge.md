---
id: php-enum-import-edge
language: php
category: import
expectation: edge
cites: "php.net language.enumerations (enum is a class-like symbol, 8.1); research 2026-06-15 PART E §E13"
---

## Rule

An enum NAME is a class-like symbol, name-resolved identically to a class. So
`use App\Enums\Suit;` is an A1-style class import: the extractor emits the FQN
`App\Enums\Suit` (the `use` operand is treated uniformly across class / interface /
trait / enum), and the resolver maps it to the enum's file by PSR-4.

## Files

```php path=src/Enums/Suit.php
<?php
namespace App\Enums;
enum Suit { case Hearts; case Spades; }
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Enums\Suit;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Enums      # `use App\Enums\Suit;` (enum is class-like) → src/Enums/Suit.php (node Enums)

## Why

An enum is class-like, so its `use` import is the same FQN-keyed edge as a class import.
