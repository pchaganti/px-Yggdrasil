---
id: php-dynamic-new-expr-silence
language: php
category: dynamic
expectation: silence
cites: "php.net language.oop5.basic (F3 new with expression, 8.0); research 2026-06-15 PART F §F3"
---

## Rule

`new ($f())()` instantiates the class named by a runtime expression (PHP 8.0+) — no
static class-name token. The extractor emits nothing.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($f) { return new ($f())(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `new ($f())()` instantiates a runtime expression → no static token → silent

## Why

The class is named by an arbitrary runtime expression; there is no static name to
resolve, so it is silent.
