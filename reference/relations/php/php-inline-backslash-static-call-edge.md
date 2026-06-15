---
id: php-inline-backslash-static-call-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1; language.oop5.static; research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

A static call on a leading-backslash class name `\App\Audit\AuditLog::record("x")` is
an absolute class reference (Rule 1) — the qualified_name is the scope of a
scoped_call_expression, a class-autoload position. It is shadow-free, so the extractor
emits `App\Audit\AuditLog`.

## Files

```php path=src/Audit/AuditLog.php
<?php
namespace App\Audit;
class AuditLog {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { \App\Audit\AuditLog::record("x"); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Audit      # absolute `\App\Audit\AuditLog::record()` → src/Audit/AuditLog.php (node Audit)

## Why

The leading-backslash static-call scope is absolute and shadow-free, so it edges; only
the bare (relative) scope stays silent.
