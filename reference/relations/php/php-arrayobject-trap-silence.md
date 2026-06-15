---
id: php-arrayobject-trap-silence
language: php
category: trap
expectation: silence
cites: "php.net language.namespaces.rules Rule 6 (no global fallback); research 2026-06-15 trap T2"
---

## Rule

`new ArrayObject()` inside a namespace resolves to `A\B\C\ArrayObject` by
current-namespace prepend (Rule 6), never the stdlib `\ArrayObject` — there is no class
global fallback. Binding it to the global stdlib type would be a false positive. The
import-only model never resolves a bare class name, so it is silent.

## Files

```php path=src/Std/ArrayObject.php
<?php
namespace App\Std;
class ArrayObject {}
```

```php path=src/Order/Service.php
<?php
namespace A\B\C;
class Service { function f() { return new ArrayObject(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # bare `new ArrayObject()` resolves to `A\B\C\ArrayObject` (no global fallback) → never the stdlib `\ArrayObject` → silent

## Why

The no-global-fallback rule means a bare stdlib-looking name is current-namespace
relative; binding it to the global type would be a false positive, so it is silent.
