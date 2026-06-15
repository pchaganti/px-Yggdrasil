---
id: php-static-call-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.static (E7 static access); research 2026-06-15 PART E §E7"
---

## Rule

A static access on a literal class name with no leading backslash —
`AuditLog::record("x")` — references the namespace-relative class `App\AuditLog`
(Rule 6). It is a usage-site form; the import-only model emits nothing.

## Files

```php path=src/Audit/AuditLog.php
<?php
namespace App\Audit;
class AuditLog {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { AuditLog::record("x"); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `AuditLog::record()` is a usage-site reference → silent recall miss

## Why

The class operand is namespace-relative; binding it needs the use table, so it is left
silent.
