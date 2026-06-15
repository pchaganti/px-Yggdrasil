---
id: php-psr4-single-root-edge
language: php
category: import
expectation: edge
cites: "PSR-4 §3 (prefix → base directory); research 2026-06-15 PART C §C1"
---

## Rule

A single-root PSR-4 prefix `App\` → `src/` maps the imported FQN `App\Payment\Gateway`
to `src/Payment/Gateway.php` (sub-namespaces → subdirectories, class name → `<name>.php`,
case-sensitive). When that file exists the import is a real edge.

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

- src/Order/Handler.php:3 -> node:Payment      # `App\Payment\Gateway` under `App\` → `src/` resolves to src/Payment/Gateway.php (node Payment)

## Why

A single-root prefix maps the FQN to exactly one path; the file exists, so the import
edges.
