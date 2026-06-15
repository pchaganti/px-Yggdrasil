---
id: php-dynamic-obj-class-silence
language: php
category: dynamic
expectation: silence
cites: "php.net language.oop5.basic (F2 $obj::class, 8.0 runtime); research 2026-06-15 PART F §F2"
---

## Rule

`$obj::class` (PHP 8.0+) equals `get_class($obj)` at runtime — it is not a static
class-name token. The extractor emits nothing.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($obj) { return $obj::class; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `$obj::class` is a runtime get_class → no static token → silent

## Why

`$obj::class` resolves the class of a runtime object, not a static name, so there is
nothing to resolve — silenced.
