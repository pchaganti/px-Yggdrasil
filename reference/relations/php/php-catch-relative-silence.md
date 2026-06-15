---
id: php-catch-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.exceptions (E8 catch / multi-catch); research 2026-06-15 PART E §E8"
---

## Rule

A `catch (DomainError | OtherError $e)` names exception class references without a
leading backslash — namespace-relative usage sites (multi-catch since 8.0). The
import-only model emits nothing for either operand.

## Files

```php path=src/Err/DomainError.php
<?php
namespace App\Err;
class DomainError {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { try {} catch (DomainError | OtherError $e) {} } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `catch (DomainError | OtherError ...)` operands are usage-site references → silent recall miss

## Why

The caught types are namespace-relative; the import-only model does not resolve them.
