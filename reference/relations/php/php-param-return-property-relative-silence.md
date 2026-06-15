---
id: php-param-return-property-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.types.declarations (E4 type positions); research 2026-06-15 PART E §E4"
---

## Rule

Class names in parameter, return, and property type positions — `private Repo $r;`,
`function m(Logger $l): Result` — written without a leading backslash are
namespace-relative usage-site references resolved by the §rules precedence (including
union / intersection / DNF composites and 8.3 typed constants). The import-only model
emits nothing for them.

## Files

```php path=src/Dep/Repo.php
<?php
namespace App\Dep;
class Repo {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { private Repo $r; function m(Logger $l): Result {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Repo` / `Logger` / `Result` type hints are usage-site references → silent recall miss

## Why

A relative type hint binds against the namespace + use table; the import-only model
declines to resolve it.
