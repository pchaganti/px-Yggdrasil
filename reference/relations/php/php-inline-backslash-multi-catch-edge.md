---
id: php-inline-backslash-multi-catch-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.exceptions; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

Leading-backslash names in a multi-catch `catch (\App\E1\DomainError | \App\E2\OtherError
$e)` are absolute class references (Rule 1). Each caught type is wrapped in a named_type
in a class-autoload position, shadow-free, so the extractor emits both FQNs — one edge
each.

## Files

```php path=src/E1/DomainError.php
<?php
namespace App\E1;
class DomainError {}
```

```php path=src/E2/OtherError.php
<?php
namespace App\E2;
class OtherError {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { try {} catch (\App\E1\DomainError | \App\E2\OtherError $e) {} } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:E1      # absolute `\App\E1\DomainError` → src/E1/DomainError.php (node E1)
- src/Order/Handler.php:3 -> node:E2      # absolute `\App\E2\OtherError` → src/E2/OtherError.php (node E2)

## Why

Each absolute caught type is shadow-free and resolves independently, so a multi-catch of
two types is two distinct edges.
