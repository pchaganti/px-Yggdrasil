---
id: php-dynamic-class-alias-silence
language: php
category: dynamic
expectation: silence
cites: "php.net function.class-alias (F5 runtime aliasing); research 2026-06-15 PART F §F5"
---

## Rule

`class_alias("App\\Foo", "F")` creates an alias at RUNTIME from string-literal
operands — invisible to a static tool. The extractor emits nothing; the class name
lives only inside a string argument.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { class_alias("App\\Pay\\Gateway", "F"); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `class_alias(...)` operands are string literals resolved at runtime → silent

## Why

A class named only inside a string argument is not a static reference; runtime aliasing
is invisible to the static tool, so it is silenced.
