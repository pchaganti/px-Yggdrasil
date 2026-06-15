---
id: php-psr4-longest-prefix-wins-edge
language: php
category: import
expectation: edge
cites: "PSR-4 (longest matching prefix); research 2026-06-15 PART C §C2"
---

## Rule

PSR-4 prefixes nest; the LONGEST matching prefix governs the base directory. With
`App\` → `src/` and `App\Tests\` → `tests/`, the FQN `App\Tests\Unit\GatewayTest` maps
under `App\Tests\` → `tests/Unit/GatewayTest.php`, NOT under `App\` → `src/Tests/Unit/...`.
Using the shorter prefix would map to the wrong directory and miss the file.

## Files

```php path=tests/Unit/GatewayTest.php
<?php
namespace App\Tests\Unit;
class GatewayTest {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Tests\Unit\GatewayTest;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/", "App\\Tests\\": "tests/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Unit      # longest prefix `App\Tests\` → `tests/` resolves to tests/Unit/GatewayTest.php (node Unit)

## Why

The longest matching prefix governs the base dir; choosing the shorter one would map to
the wrong file, so longest-prefix-wins is decisive.
