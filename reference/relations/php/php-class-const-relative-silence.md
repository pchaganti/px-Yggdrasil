---
id: php-class-const-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.basic (E6 ::class literal); research 2026-06-15 PART E §E6"
---

## Rule

`Gateway::class` with no leading backslash is a compile-time class-name literal
resolved against the current namespace + `use` imports (Rule 6). It is a genuine
static reference, but a namespace-relative one — the import-only model declines to
surface it (silence), a tolerated recall miss.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { return Gateway::class; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Gateway::class` is a usage-site reference → silent recall miss

## Why

The literal resolves against the file's namespace + use table; the import-only model
does not reconstruct that, so it stays silent.
