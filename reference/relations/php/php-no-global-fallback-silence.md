---
id: php-no-global-fallback-silence
language: php
category: trap
expectation: silence
cites: "php.net language.namespaces.rules Rule 6 (no class global fallback); research 2026-06-15 trap T1"
---

## Rule

A bare class name `Logger` with no `use` import resolves to `App\Logger` by
current-namespace prepend (Rule 6) — PHP has NO global fallback for classes, so it is
NEVER `\Logger` or `Psr\Log\Logger`. Emitting an edge to any other node's `Logger`
would be a false positive. The import-only model never resolves a bare class name, so
no mis-binding is possible.

## Files

```php path=src/Log/Logger.php
<?php
namespace App\Log;
class Logger {}
```

```php path=src/Order/Service.php
<?php
namespace App;
class Service { function f(Logger $l) {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # bare `Logger` resolves to `App\Logger` (no global fallback) → never `App\Log\Logger` → silent

## Why

There is no class global fallback in PHP; binding a bare name to an unrelated `Logger`
node is the textbook false positive the import-only model structurally avoids.
