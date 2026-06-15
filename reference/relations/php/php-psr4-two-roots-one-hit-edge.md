---
id: php-psr4-two-roots-one-hit-edge
language: php
category: import
expectation: edge
cites: "PSR-4 (≥1 base directory; anti-over-silencing); research 2026-06-15 PART C §C4"
---

## Rule

A PSR-4 prefix may map to several base directories: `App\` → `["src", "lib"]`. When the
class file exists under EXACTLY ONE of them the mapping is unambiguous → resolve it.
Over-silencing here would be a needless recall miss. The FQN `App\Pay\G` exists only at
`src/Pay/G.php`, so it resolves to that single file.

## Files

```php path=src/Pay/G.php
<?php
namespace App\Pay;
class G {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Pay\G;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": ["src/", "lib/"] } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Pay      # `App\Pay\G` exists under exactly one of the two roots (src) → unambiguous → resolves to src/Pay/G.php (node Pay)

## Why

Exactly one existing hit across the prefix's roots is unambiguous; resolving it avoids a
needless recall miss while staying false-positive-free.
