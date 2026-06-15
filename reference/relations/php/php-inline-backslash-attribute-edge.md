---
id: php-inline-backslash-attribute-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.attributes.syntax; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

A leading-backslash attribute `#[\App\Http\Route("/x")]` is an absolute class reference
(Rule 1) — an attribute name in a class-autoload position. It is shadow-free, so the
extractor emits `App\Http\Route`.

## Files

```php path=src/Http/Route.php
<?php
namespace App\Http;
class Route {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
#[\App\Http\Route("/x")]
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Http      # absolute attribute `#[\App\Http\Route]` → src/Http/Route.php (node Http)

## Why

The leading-backslash attribute name is absolute and shadow-free, so it edges; only the
bare (relative) attribute stays silent.
