---
id: php-plain-use-fqn-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A1 plain class import); research 2026-06-15 PART A §A1"
---

## Rule

A plain `use App\Foo;` imports the fully-qualified type `App\Foo` and binds the
local name `Foo`. The operand is absolute (import names are not processed relative
to the current namespace), so the extractor emits the FQN verbatim; the resolver
maps it to a `.php` file by composer PSR-4 (`App\` → `src/` → `src/Payment/Gateway.php`).
The `use` line IS the per-type edge — a real dependency on the file declaring that
exact FQN.

## Files

```php path=src/Payment/Gateway.php
<?php
namespace App\Payment;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Payment\Gateway;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Payment      # `use App\Payment\Gateway` resolves to src/Payment/Gateway.php (node Payment)

## Why

The fully-qualified import operand maps to exactly one file by PSR-4; a different
namespace is a different file, so there is nothing to mis-bind.
