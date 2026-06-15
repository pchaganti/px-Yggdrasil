---
id: php-attribute-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.attributes.syntax (E9 attribute); research 2026-06-15 PART E §E9"
---

## Rule

An attribute name `#[Route("/x")]` with no leading backslash is a class reference
resolved exactly like any class name (Rule 6) — namespace-relative here. The
import-only model emits nothing for an attribute usage; all attribute positions added
across 8.0→8.5 are the same form in new locations.

## Files

```php path=src/Http/Route.php
<?php
namespace App\Http;
class Route {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
#[Route("/x")]
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative attribute `#[Route(...)]` is a usage-site class reference → silent recall miss

## Why

The attribute name is namespace-relative; resolving it needs the use table, so it is
left silent.
