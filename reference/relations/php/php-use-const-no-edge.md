---
id: php-use-const-no-edge
language: php
category: import
expectation: silence
cites: "php.net language.namespaces.importing (A8 use const); research 2026-06-15 PART A §A8"
---

## Rule

`use const App\Util\MAX;` imports a CONSTANT into the constant table, not a class. The
extractor recognizes the declaration-level `const` keyword and skips the whole
declaration — no class dependency exists. Treating it as a class import would fabricate
an edge to a non-existent class FQN.

## Files

```php path=src/Util/constants.php
<?php
namespace App\Util;
const MAX = 1;
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use const App\Util\MAX;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `use const` imports a constant, not a class → no class edge

## Why

A constant import binds the constant table; emitting it as a class would be a false
positive, so it is dropped wholesale.
