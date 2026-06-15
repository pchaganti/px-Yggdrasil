---
id: php-extends-implements-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.basic (E2 extends/implements); research 2026-06-15 PART E §E2"
---

## Rule

A supertype list `class C extends Base implements Flowable, Other` names class /
interface references without a leading backslash — namespace-relative usage sites
resolved by the §rules precedence. The import-only model emits nothing for any of
them; resolving a bare supertype name would reintroduce the no-global-fallback /
sibling-same-name trap.

## Files

```php path=src/Base/Base.php
<?php
namespace App\Base;
class Base {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler extends Base implements Flowable, Other {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `extends Base` / `implements Flowable, Other` are usage-site references → silent recall miss

## Why

The supertype names are namespace-relative; binding them needs the use table, so the
import-only model leaves them silent.
