---
id: php-inline-backslash-param-return-property-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.types.declarations; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

Leading-backslash names in parameter, return, and property type positions are absolute
class references (Rule 1), shadow-free and PSR-4-resolved. `private \App\Dep\Repo $r;
function m(\App\Log\Logger $l): \App\Res\Result {}` emits all three FQNs, each its own
per-type edge.

## Files

```php path=src/Dep/Repo.php
<?php
namespace App\Dep;
class Repo {}
```

```php path=src/Log/Logger.php
<?php
namespace App\Log;
class Logger {}
```

```php path=src/Res/Result.php
<?php
namespace App\Res;
class Result {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { private \App\Dep\Repo $r; function m(\App\Log\Logger $l): \App\Res\Result {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Dep      # property type `\App\Dep\Repo` → src/Dep/Repo.php (node Dep)
- src/Order/Handler.php:3 -> node:Log      # parameter type `\App\Log\Logger` → src/Log/Logger.php (node Log)
- src/Order/Handler.php:3 -> node:Res      # return type `\App\Res\Result` → src/Res/Result.php (node Res)

## Why

Each absolute type-position name is shadow-free and resolves independently, so the three
type hints are three distinct edges.
