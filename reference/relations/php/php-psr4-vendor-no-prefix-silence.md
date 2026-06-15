---
id: php-psr4-vendor-no-prefix-silence
language: php
category: import
expectation: silence
cites: "PSR-4 (no matching prefix); research 2026-06-15 PART C §C3"
---

## Rule

An imported FQN whose top-level prefix is not in the project's PSR-4 map — a vendor /
third-party class like `Psr\Log\LoggerInterface` — resolves to nothing (fail-to-silence).
Guessing a root for a vendor class would be a false positive.

## Files

```php path=src/Payment/Gateway.php
<?php
namespace App\Payment;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use Psr\Log\LoggerInterface;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `Psr\Log\LoggerInterface` matches no PSR-4 prefix → unresolved → silent

## Why

A vendor FQN has no mapped prefix; the resolver never guesses a root, so it is silent —
no false edge to any project node.
