---
id: php-dynamic-new-var-silence
language: php
category: dynamic
expectation: silence
cites: "php.net language.namespaces.dynamic (F1 variable class name); research 2026-06-15 PART F §F1"
---

## Rule

`new $var()` names a class through a string variable resolved at RUNTIME — the `use`
import table is NEVER applied to a dynamic name, and it is treated as effectively
fully-qualified. Nothing is statically resolvable; resolving `$var` to any class is a
pure guess and a false positive. The extractor emits nothing.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($var) { return new $var(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `new $var()` is a runtime variable class name → not statically resolvable → silent

## Why

A variable class name is a runtime value; the import table is never applied to it, so
any resolution would be a guess — silenced.
