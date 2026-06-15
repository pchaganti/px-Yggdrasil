---
id: php-dynamic-namespace-concat-silence
language: php
category: dynamic
expectation: silence
cites: "php.net language.namespaces.dynamic (F4 string-built names); research 2026-06-15 PART F §F4"
---

## Rule

A class name assembled from strings — `__NAMESPACE__ . "\\Foo"` then `new $c()` — is a
runtime value; `__NAMESPACE__` is a magic constant. There is no static class-name token,
so the extractor emits nothing.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { $c = __NAMESPACE__ . "\\Foo"; return new $c(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # a string-built class name is a runtime value → no static token → silent

## Why

A name built by string concatenation is computed at runtime; there is no static token to
resolve, so it is silenced.
