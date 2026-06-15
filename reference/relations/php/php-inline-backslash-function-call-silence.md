---
id: php-inline-backslash-function-call-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 7 (functions resolved at call time); research 2026-06-15 PART A (inline allowlist excludes function calls)"
---

## Rule

A leading-backslash name in FUNCTION-call position `\App\Util\format()` does NOT trigger
class autoloading — PHP keeps functions in a separate namespace resolved at call time,
never mapped to a PSR-4 class file. The extractor's class-autoload-position allowlist
excludes function-call parents, so it emits nothing. Emitting it could bind to an
unrelated class file that merely shares the path.

## Files

```php path=src/Util/format.php
<?php
namespace App\Util;
class format {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
function m() { \App\Util\format(); }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # leading-`\` FUNCTION call is not a class-autoload position → silent (excluded from the allowlist)

## Why

PHP resolves functions at call time, not via PSR-4 class autoloading, so a
function-call FQN is excluded from inline detection — emitting it would be a false
positive against a same-path class file.
