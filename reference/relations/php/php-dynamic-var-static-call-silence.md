---
id: php-dynamic-var-static-call-silence
language: php
category: dynamic
expectation: silence
cites: "php.net language.namespaces.dynamic (F2 variable static access); research 2026-06-15 PART F §F2"
---

## Rule

`$var::go()` dispatches a static call through a variable at RUNTIME — there is no static
class-name token. The extractor emits nothing; resolving the variable would be a guess.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($var) { return $var::go(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `$var::go()` is a runtime variable static call → no static token → silent

## Why

Static access through a variable is runtime-dispatched; there is no static name to
resolve, so it is silent.
