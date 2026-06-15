---
id: php-leading-backslash-use-edge
language: php
category: import
expectation: edge
cites: "php.net language.namespaces.importing (A3 leading-backslash operand); research 2026-06-15 PART A §A3"
---

## Rule

In a `use \App\Foo;` import the leading backslash is unnecessary (import names are
always fully qualified). The extractor strips exactly one leading `\`, yielding the
specifier `App\Payment\Gateway` — identical to the plain form. Not stripping it
would produce `\App\Payment\Gateway`, which never matches a PSR-4-keyed FQN (those
carry no leading backslash) and would silently miss the edge.

## Files

```php path=src/Payment/Gateway.php
<?php
namespace App\Payment;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use \App\Payment\Gateway;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Payment      # one leading `\` stripped → `App\Payment\Gateway` → src/Payment/Gateway.php (node Payment)

## Why

Stripping exactly one leading backslash normalizes the absolute operand to the same
FQN the plain import produces; the edge is identical.
