---
id: php-aliased-use-fqn-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A2 aliased import); research 2026-06-15 PART A §A2"
---

## Rule

`use App\Foo as Bar;` binds the LOCAL short name `Bar`, but the imported FQN is
still `App\Foo`. The alias is a per-file rename, never the target — the extractor
records `App\Payment\Gateway` and drops `G`. Emitting the alias (or `App\Payment\G`)
would name nothing in the depended-on file and is a false positive the FQN key
rejects by construction.

## Files

```php path=src/Payment/Gateway.php
<?php
namespace App\Payment;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Payment\Gateway as G;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Payment      # the FQN before `as` resolves to src/Payment/Gateway.php (node Payment); the alias `G` is never a target

## Why

The alias is the local binding; the rename-free FQN is the key, so the edge points
at the imported file and never at a phantom `G`.
