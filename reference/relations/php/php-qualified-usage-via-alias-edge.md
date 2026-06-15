---
id: php-qualified-usage-via-alias-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 3 (E11 qualified usage via alias); research 2026-06-15 PART E §E11"
---

## Rule

With `use App\Domain\Models;` the local name `Models` may prefix a qualified usage
`new Models\User()`, whose first segment is translated by the import table to
`App\Domain\Models\User` (Rule 3). The IMPORT line `use App\Domain\Models;` is the only
emitted edge (it resolves to the file declaring that FQN); the qualified usage is a
separate, silenced usage-site form. So exactly one edge survives — the import — and the
usage adds nothing.

## Files

```php path=src/Domain/Models.php
<?php
namespace App\Domain;
class Models {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
use App\Domain\Models;
class Handler { function m() { $u = new Models\User(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Domain      # only the import `use App\Domain\Models` resolves (src/Domain/Models.php, node Domain); the usage `Models\User` is silent

## Why

The import operand is the only edge; the downstream qualified usage is usage-site and
silent, so the import is never double-counted or turned into a phantom `Models\User`.
