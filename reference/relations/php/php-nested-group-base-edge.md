---
id: php-nested-group-base-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A5 nested-group base); research 2026-06-15 PART A §A5"
---

## Rule

A group clause may itself be a multi-segment qualified name. The imported FQN is the
leading base + `\` + the clause's full (possibly multi-segment) name. In
`use App\Sub\{Inner\Deep, Plain};` the clauses resolve to `App\Sub\Inner\Deep` and
`App\Sub\Plain`. Splitting a clause at the wrong boundary, or dropping the `Inner\`
segment, mis-keys the FQN.

## Files

```php path=src/Sub/Inner/Deep.php
<?php
namespace App\Sub\Inner;
class Deep {}
```

```php path=src/Sub/Plain.php
<?php
namespace App\Sub;
class Plain {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Sub\{Inner\Deep, Plain};
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Inner      # base + `Inner\Deep` = `App\Sub\Inner\Deep` → src/Sub/Inner/Deep.php (node Inner)
- src/Order/Handler.php:3 -> node:Sub        # base + `Plain` = `App\Sub\Plain` → src/Sub/Plain.php (node Sub)

## Why

A nested-group clause keeps its multi-segment shape under the base; the FQN is base +
the verbatim clause, so each resolves to its own file.
