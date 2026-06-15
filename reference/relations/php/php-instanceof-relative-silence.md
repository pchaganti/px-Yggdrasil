---
id: php-instanceof-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.operators.type (E5 instanceof); research 2026-06-15 PART E §E5"
---

## Rule

`$x instanceof Timer` with no leading backslash names a namespace-relative class
reference (Rule 6). It is a usage-site form — the import-only model emits nothing,
rather than guess at a global `Timer`.

## Files

```php path=src/Metrics/Timer.php
<?php
namespace App\Metrics;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($x) { return $x instanceof Timer; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `instanceof Timer` is a usage-site reference → silent recall miss

## Why

The operand is namespace-relative; without the use table it cannot be bound, so it is
left silent.
