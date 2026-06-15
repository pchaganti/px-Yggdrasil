---
id: php-grouped-aliased-clause-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A4 grouped-aliased clause); research 2026-06-15 PART A §A4"
---

## Rule

A clause inside a grouped import may carry its own `as` alias. The alias binds the
local name only; the imported FQN is still base + the clause's name. In
`use App\Pay\{Card\Visa, Cash\Note as N};` the edges are `App\Pay\Card\Visa` and
`App\Pay\Cash\Note` — the alias `N` is the local rename, never an `App\Pay\Cash\N`
target (which would be a false positive).

## Files

```php path=src/Pay/Card/Visa.php
<?php
namespace App\Pay\Card;
class Visa {}
```

```php path=src/Pay/Cash/Note.php
<?php
namespace App\Pay\Cash;
class Note {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Pay\{Card\Visa, Cash\Note as N};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Card      # base + `Card\Visa` = `App\Pay\Card\Visa` → src/Pay/Card/Visa.php (node Card)
- src/Order/Handler.php:3 -> node:Cash      # base + `Cash\Note` = `App\Pay\Cash\Note` → src/Pay/Cash/Note.php (node Cash); alias `N` is never a target

## Why

A per-clause alias is a local rename; the imported FQN (base prepended) is the key,
so the aliased clause edges to the real file and never to a phantom alias type.
