---
id: php-grouped-use-function-no-edge
language: php
category: import
expectation: silence
cites: "php.net language.namespaces.importing (A9 grouped use function); research 2026-06-15 PART A §A9"
---

## Rule

In `use function App\Util\{format, trim};` the `function` keyword sits directly under
the declaration, so EVERY clause it introduces is a function import. The extractor
skips the whole declaration — no class edge for any clause. Emitting any clause as a
class FQN would be a false positive.

## Files

```php path=src/Util/format.php
<?php
namespace App\Util;
function format() {}
function trim() {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use function App\Util\{format, trim};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # declaration-level `use function` → every clause is a function → no class edge

## Why

The declaration-level keyword marks every clause as a function import; the whole group
is dropped, so no class edge can fire.
