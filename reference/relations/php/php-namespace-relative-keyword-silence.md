---
id: php-namespace-relative-keyword-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 2 (E10 relative namespace\\Foo); research 2026-06-15 PART E §E10"
---

## Rule

A `namespace\Foo` reference (the `namespace` keyword prefix) resolves to the current
namespace + `Foo` (Rule 2) — `App\Foo` in `namespace App`. It is a usage-site form and
the import table is not consulted; the import-only model emits nothing.

## Files

```php path=src/Sub/Foo.php
<?php
namespace App\Sub;
class Foo {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m(): namespace\Foo {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `namespace\Foo` resolves to the current namespace (`App\Foo`), a usage-site form → silent recall miss

## Why

The `namespace\` keyword binds against the current namespace, not the import table; the
import-only model leaves it silent.
