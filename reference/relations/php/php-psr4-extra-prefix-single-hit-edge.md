---
id: php-psr4-extra-prefix-single-hit-edge
language: php
category: import
expectation: edge
cites: "PSR-4 (longest-prefix unique; an empty prefix is forbidden/skipped); research 2026-06-15 PART C §C6"
---

## Rule

A second, unrelated PSR-4 prefix coexisting with `App\` does not manufacture a second
hit for the chosen prefix. With `App\` → `src/` and `Legacy\` → `legacy/`, the FQN
`App\Pay\G` matches only the longest unique prefix `App\`, and only its root holds the
file → a single hit → resolve. (PSR-4 forbids an empty `""` prefix, so a catch-all is
skipped and never adds a phantom hit.)

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
{ "autoload": { "psr-4": { "App\\": "src/", "Legacy\\": "legacy/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Pay      # `App\Pay\G` matches only `App\` (single hit) → resolves to src/Pay/G.php (node Pay); the unrelated prefix adds no second hit

## Why

Longest-prefix is unique and only its root holds the file; a coexisting unrelated prefix
does not create ambiguity, so the single hit resolves.
