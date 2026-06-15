---
id: php-inline-backslash-bare-constant-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 7 (constants resolved at runtime); research 2026-06-15 PART A (inline allowlist excludes bare constants)"
---

## Rule

A leading-backslash name in BARE-CONSTANT position `\App\C\FOO` does NOT trigger class
autoloading — PHP keeps constants in a separate namespace, never mapped to a PSR-4
class file. The extractor's class-autoload-position allowlist excludes the generic
expression parent of a bare constant, so it emits nothing.

## Files

```php path=src/C/FOO.php
<?php
namespace App\C;
class FOO {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
function m() { $x = \App\C\FOO; }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # leading-`\` bare CONSTANT is not a class-autoload position → silent (excluded from the allowlist)

## Why

PHP resolves constants at runtime, not via PSR-4 class autoloading, so a bare-constant
FQN is excluded from inline detection — emitting it would be a false positive against a
same-path class file.
