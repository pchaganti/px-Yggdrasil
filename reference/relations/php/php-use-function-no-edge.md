---
id: php-use-function-no-edge
language: php
category: import
expectation: silence
cites: "php.net language.namespaces.importing (A8 use function); research 2026-06-15 PART A §A8"
---

## Rule

`use function App\Util\format;` imports a FUNCTION into the function table, not a
class. The extractor recognizes the declaration-level `function` keyword and skips the
whole declaration — no class dependency exists. Treating it as a class import would
fabricate an edge to a non-existent class FQN. Recall is unaffected: functions are not
nodes.

## Files

```php path=src/Util/format.php
<?php
namespace App\Util;
function format() {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use function App\Util\format;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `use function` imports a function, not a class → no class edge

## Why

A function import binds the function table; emitting it as a class would be a false
positive, so it is dropped wholesale.
