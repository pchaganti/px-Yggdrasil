---
id: php-inline-backslash-instanceof-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.operators.type; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

`$x instanceof \App\M\Timer` with a leading backslash is an absolute class reference
(Rule 1). The right operand of `instanceof` in a class-autoload position is shadow-free,
so the extractor emits `App\M\Timer` and the resolver maps it by PSR-4.

## Files

```php path=src/M/Timer.php
<?php
namespace App\M;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($x) { return $x instanceof \App\M\Timer; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:M      # absolute `instanceof \App\M\Timer` → src/M/Timer.php (node M)

## Why

The leading-backslash instanceof operand is absolute and shadow-free, so it edges; only
the bare (relative) operand stays silent.
