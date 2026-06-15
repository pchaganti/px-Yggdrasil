---
id: php-inline-backslash-trait-use-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.oop5.traits; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

An in-class trait `use \App\Mixin\Timestamps;` with a leading backslash is an ABSOLUTE
trait reference (Rule 1) — unlike the namespace-relative bare in-class trait `use`. The
leading `\` makes it shadow-free, so the extractor emits `App\Mixin\Timestamps` and the
resolver maps it by PSR-4.

## Files

```php path=src/Mixin/Timestamps.php
<?php
namespace App\Mixin;
trait Timestamps {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { use \App\Mixin\Timestamps; }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Mixin      # absolute in-class trait `use \App\Mixin\Timestamps;` → src/Mixin/Timestamps.php (node Mixin)

## Why

A leading-backslash in-class trait `use` is absolute and shadow-free, so it edges; only
the bare (relative) in-class trait `use` stays silent.
