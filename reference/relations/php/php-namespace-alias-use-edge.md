---
id: php-namespace-alias-use-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A6 namespace-alias import); research 2026-06-15 PART A §A6"
---

## Rule

`use App\Domain\Models;` binds the local name `Models`, which a downstream qualified
usage `new Models\User()` could later prefix (→ `App\Domain\Models\User`, a separate
usage-site form). The IMPORT line itself names exactly the FQN `App\Domain\Models` —
that is the only emitted edge, and it points at the file declaring that FQN, never at
the local name `Models`. Here `App\Domain\Models` happens to be a class declared in
its own file; resolving the operand verbatim is the safe, FQN-keyed direction.

## Files

```php path=src/Domain/Models.php
<?php
namespace App\Domain;
class Models {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Domain\Models;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Domain      # `use App\Domain\Models` resolves to src/Domain/Models.php (node Domain); never the local name `Models`

## Why

The import operand is the FQN; the local binding `Models` is never the target, so a
downstream qualified usage cannot turn the import edge into a phantom.
