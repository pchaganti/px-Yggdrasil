---
id: php-inline-backslash-class-const-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.oop5.basic; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

`\App\Pay\Gateway::class` with a leading backslash is an absolute class-name literal
(Rule 1) — a class-constant access in a class-autoload position. It is shadow-free, so
the extractor emits `App\Pay\Gateway` and the resolver maps it by PSR-4.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { return \App\Pay\Gateway::class; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Pay      # absolute `\App\Pay\Gateway::class` → src/Pay/Gateway.php (node Pay)

## Why

The leading-backslash `::class` operand is absolute and shadow-free, so it edges; only
the bare (relative) literal stays silent.
