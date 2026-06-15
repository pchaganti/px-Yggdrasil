---
id: php-inline-backslash-extends-implements-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.oop5.basic; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

Leading-backslash names in `extends` / `implements` clauses are absolute class /
interface references (Rule 1), shadow-free and PSR-4-resolved. `class C extends
\App\Base\Base implements \App\Flow\Flowable` emits both FQNs, each its own per-type
edge to its own file.

## Files

```php path=src/Base/Base.php
<?php
namespace App\Base;
class Base {}
```

```php path=src/Flow/Flowable.php
<?php
namespace App\Flow;
interface Flowable {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler extends \App\Base\Base implements \App\Flow\Flowable {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Base      # `extends \App\Base\Base` → src/Base/Base.php (node Base)
- src/Order/Handler.php:3 -> node:Flow      # `implements \App\Flow\Flowable` → src/Flow/Flowable.php (node Flow)

## Why

Each absolute supertype name is shadow-free and resolves independently, so a base class
and an interface are two distinct edges.
